window.assignManager = {
  MENU_ASSIGN_ID: "open-in-this-container",
  MENU_REMOVE_ID: "remove-open-in-this-container",
  MENU_SEPARATOR_ID: "separator",
  MENU_HIDE_ID: "hide-container",
  MENU_MOVE_ID: "move-to-new-window-container",
  OPEN_IN_CONTAINER: "open-bookmark-in-container-tab",
  storageArea: {
    area: browser.storage.local,
    exemptedTabs: {},

    getSiteStoreKey(pageUrlorUrlKey) {
      if (pageUrlorUrlKey.includes("siteContainerMap@@_")) return pageUrlorUrlKey;
      const url = new window.URL(pageUrlorUrlKey);
      const storagePrefix = "siteContainerMap@@_";
      if (url.port === "80" || url.port === "443") {
        return `${storagePrefix}${url.hostname}`;
      } else {
        return `${storagePrefix}${url.hostname}${url.port}`;
      }
    },

    setExempted(pageUrlorUrlKey, tabId) {
      const siteStoreKey = this.getSiteStoreKey(pageUrlorUrlKey);
      if (!(siteStoreKey in this.exemptedTabs)) {
        this.exemptedTabs[siteStoreKey] = [];
      }
      this.exemptedTabs[siteStoreKey].push(tabId);
    },

    removeExempted(pageUrlorUrlKey) {
      const siteStoreKey = this.getSiteStoreKey(pageUrlorUrlKey);
      this.exemptedTabs[siteStoreKey] = [];
    },

    isExempted(pageUrlorUrlKey, tabId) {
      const siteStoreKey = this.getSiteStoreKey(pageUrlorUrlKey);
      if (!(siteStoreKey in this.exemptedTabs)) {
        return false;
      }
      return this.exemptedTabs[siteStoreKey].includes(tabId);
    },

    get(pageUrlorUrlKey) {
      const siteStoreKey = this.getSiteStoreKey(pageUrlorUrlKey);
      return this.getByUrlKey(siteStoreKey);
    },

    async getSyncEnabled() {
      const { syncEnabled } = await browser.storage.local.get("syncEnabled");
      return !!syncEnabled;
    },

    async getReplaceTabEnabled() {
      const { replaceTabEnabled } = await browser.storage.local.get("replaceTabEnabled");
      return !!replaceTabEnabled;
    },

    userContextToList(siteConfig) {
      if ("userContextIds" in siteConfig && siteConfig.neverAsk !== true) {
        return siteConfig;
      }
      if ("userContextIds" in siteConfig) {
        siteConfig.neverAsk = siteConfig.userContextIds.length === 1 ?
          siteConfig.userContextIds[0] : false;
        return siteConfig;
      }
      const {
        userContextId,
        neverAsk: boolNeverAsk = false,
        ...rest
      } = siteConfig;
      return {
        userContextIds: [userContextId],
        neverAsk: boolNeverAsk ? userContextId : false,
        ...rest,
      };
    },

    getByUrlKey(siteStoreKey) {
      return new Promise((resolve, reject) => {
        this.area.get([siteStoreKey]).then((storageResponse) => {
          if (storageResponse && siteStoreKey in storageResponse) {
            resolve(this.userContextToList(storageResponse[siteStoreKey]));
          } else {
            resolve(null);
          }
        }).catch((e) => {
          reject(e);
        });
      });
    },

    async set(pageUrlorUrlKey, data, exemptedTabIds, backup = true) {
      const siteStoreKey = this.getSiteStoreKey(pageUrlorUrlKey);
      if (exemptedTabIds) {
        exemptedTabIds.forEach((tabId) => {
          this.setExempted(pageUrlorUrlKey, tabId);
        });
      }
      // eslint-disable-next-line require-atomic-updates
      data.identityMacAddonUUIDList = await Promise.all(
        data.userContextIds.map(id => identityState.lookupMACaddonUUID(id))
      );
      await this.area.set({
        [siteStoreKey]: data
      });
      const syncEnabled = await this.getSyncEnabled();
      if (backup && syncEnabled) {
        await sync.storageArea.backup({undeleteSiteStoreKey: siteStoreKey});
      }
      return;
    },

    async remove(pageUrlorUrlKey, shouldSync = true) {
      const siteStoreKey = this.getSiteStoreKey(pageUrlorUrlKey);
      // When we remove an assignment we should clear all the exemptions
      this.removeExempted(pageUrlorUrlKey);
      await this.area.remove([siteStoreKey]);
      const syncEnabled = await this.getSyncEnabled();
      if (shouldSync && syncEnabled) await sync.storageArea.backup({siteStoreKey});
      return;
    },

    async deleteContainer(userContextId) {
      const sitesByContainer = await this.getAssignedSites(userContextId);
      const deleteKeys = [];
      for (const [urlKey, urlData] of Object.entries(sitesByContainer)) {
        urlData.userContextIds = urlData.userContextIds.filter(id => id !== userContextId);
        if (urlData.neverAsk === userContextId) {
          urlData.neverAsk = false;
        }
        if (urlData.userContextIds.length) {
          this.set(urlKey, urlData, []);
        } else {
          deleteKeys.push(urlKey);
        }
      }
      this.area.remove(deleteKeys);
      identityState.storageArea.remove(backgroundLogic.cookieStoreId(userContextId));
    },

    async getAssignedSites(userContextId = null) {
      const sites = {};
      const siteConfigs = await this.area.get();
      for(const urlKey of Object.keys(siteConfigs)) {
        if (urlKey.includes("siteContainerMap@@_")) {
          const site = this.userContextToList(siteConfigs[urlKey]);
          if (!!userContextId &&
              !site.userContextIds.includes(String(userContextId))) {
            continue;
          }
          // In hindsight we should have stored this
          // TODO file a follow up to clean the storage onLoad
          site.hostname = urlKey.replace(/^siteContainerMap@@_/, "");
          sites[urlKey] = site;
        }
      }
      return sites;
    },

    /*
     * Looks for abandoned site assignments. If there is no identity with
     * the site assignment's userContextId (cookieStoreId), then the assignment
     * is removed.
     */
    async upgradeData() {
      const identitiesList = await browser.contextualIdentities.query({});
      const macConfigs = await this.area.get();
      for(const configKey of Object.keys(macConfigs)) {
        if (configKey.includes("siteContainerMap@@_")) {
          const siteConfig = this.userContextToList(macConfigs[configKey]);
          const validContextIds = [];
          for (const userContextId of siteConfig.userContextIds) {
            const cookieStoreId = backgroundLogic.cookieStoreId(userContextId);
            const match = identitiesList.find(
              localIdentity => localIdentity.cookieStoreId === cookieStoreId
            );
            if (match) {
              validContextIds.push(userContextId);
            }
          }
          if (!validContextIds.length) {
            await this.remove(configKey);
            continue;
          }
          const updatedSiteAssignment = siteConfig;
          updatedSiteAssignment.userContextIds = validContextIds;
          updatedSiteAssignment.identityMacAddonUUIDList = await Promise.all(
            validContextIds.map(id => identityState.lookupMACaddonUUID(id))
          );
          if (updatedSiteAssignment.neverAsk === true) {
            if (validContextIds.length === 1) {
              updatedSiteAssignment.neverAsk = validContextIds[0];
            } else {
              updatedSiteAssignment.neverAsk = false;
            }
          }
          await this.set(
            configKey,
            updatedSiteAssignment,
            false,
            false
          );
        }
      }

    }

  },

  _neverAsk(m) {
    const pageUrl = m.pageUrl;
    const neverAsk = m.cookieStoreId === "firefox-default" ? 0
      : backgroundLogic.getUserContextIdFromCookieStoreId(
        m.cookieStoreId,
      );
    if (neverAsk !== false) {
      // If we have existing data and for some reason it hasn't been
      // deleted etc lets update it
      this.storageArea.get(pageUrl).then((siteSettings) => {
        if (siteSettings) {
          if (!siteSettings.userContextIds.includes(neverAsk)) {
            return;
          }
          siteSettings.neverAsk = neverAsk;
          this.storageArea.set(pageUrl, siteSettings);
        }
      }).catch((e) => {
        throw e;
      });
    }
  },

  // We return here so the confirm page can load the tab when exempted
  async _exemptTab(m) {
    const pageUrl = m.pageUrl;
    await this.storageArea.setExempted(pageUrl, m.tabId);
    return true;
  },

  async handleProxifiedRequest(requestInfo) {
    // The following blocks potentially dangerous requests for privacy that come without a tabId

    if(requestInfo.tabId === -1) {
      return {};
    }

    const tab = await browser.tabs.get(requestInfo.tabId);
    const result = await proxifiedContainers.retrieve(tab.cookieStoreId);
    if (!result || !result.proxy) {
      return {};
    }

    // proxyDNS only works for SOCKS proxies
    if (["socks", "socks4"].includes(result.proxy.type)) {
      result.proxy.proxyDNS = true;
    }

    if (!result.proxy.mozProxyEnabled) {
      return result.proxy;
    }

    // Let's add the isolation key.
    return [{ ...result.proxy, connectionIsolationKey: "" + MozillaVPN_Background.isolationKey }];
  },

  // Before a request is handled by the browser we decide if we should
  // route through a different container
  async onBeforeRequest(options) {
    if (options.frameId !== 0 || options.tabId === -1) {
      return {};
    }
    this.removeContextMenu();
    const [tab, siteSettings] = await Promise.all([
      browser.tabs.get(options.tabId),
      this.storageArea.get(options.url)
    ]);
    const containers = [];
    for (const userContextId of (siteSettings ? siteSettings.userContextIds : [])) {
      let container;
      try {
        container = await browser.contextualIdentities
          .get(backgroundLogic.cookieStoreId(userContextId));
      } catch (e) {
        container = false;
      }

      // The container we have in the assignment map isn't present any
      // more so lets remove it
      if (!container) {
        this.deleteContainer(userContextId);
        if (siteSettings.neverAsk === userContextId) {
          siteSettings.neverAsk = false;
        }
        continue;
      }
      containers.push(container);
    }

    // No container we have in the assignment map is present any
    // more so lets continue the existing load
    if (siteSettings && !containers.length) {
      return {};
    }
    const currentUserContextId = this.getUserContextIdFromCookieStore(tab);

    // https://github.com/mozilla/multi-account-containers/issues/847
    //
    // Handle the case where this request's URL is not assigned to any particular
    // container. We must do the following check:
    //
    // If the current tab's container is "unlocked", we can just go ahead
    // and open the URL in the current tab, since an "unlocked" container accepts
    // any-and-all sites.
    //
    // But if the current tab's container has been "locked" by the user, then we must
    // re-open the page in the default container, because the user doesn't want random
    // sites polluting their locked container.
    //
    // For example:
    //   - the current tab's container is locked and only allows "www.google.com"
    //   - the incoming request is for "www.amazon.com", which has no specific container assignment
    //   - in this case, we must re-open "www.amazon.com" in a new tab in the default container
    const siteIsolatedReloadInDefault =
      await this._maybeSiteIsolatedReloadInDefault(siteSettings, tab);

    if (!siteIsolatedReloadInDefault) {
      if (!siteSettings
          || siteSettings.userContextIds.includes(currentUserContextId)
          || this.storageArea.isExempted(options.url, tab.id)) {
        return {};
      }
    }
    const replaceTabEnabled = await this.storageArea.getReplaceTabEnabled();
    const removeTab = backgroundLogic.NEW_TAB_PAGES.has(tab.url)
      || (messageHandler.lastCreatedTab
        && messageHandler.lastCreatedTab.id === tab.id)
      || replaceTabEnabled;
    const openTabId = removeTab ? tab.openerTabId : tab.id;

    if (!this.canceledRequests[tab.id]) {
      // we decided to cancel the request at this point, register
      // canceled request
      this.canceledRequests[tab.id] = {
        requestIds: {
          [options.requestId]: true
        },
        urls: {
          [options.url]: true
        }
      };

      // since webRequest onCompleted and onErrorOccurred are not 100%
      // reliable (see #1120)
      // we register a timer here to cleanup canceled requests, just to
      // make sure we don't
      // end up in a situation where certain urls in a tab.id stay canceled
      setTimeout(() => {
        if (this.canceledRequests[tab.id]) {
          delete this.canceledRequests[tab.id];
        }
      }, 2000);
    } else {
      let cancelEarly = false;
      if (this.canceledRequests[tab.id].requestIds[options.requestId] ||
          this.canceledRequests[tab.id].urls[options.url]) {
        // same requestId or url from the same tab
        // this is a redirect that we have to cancel early to prevent
        // opening two tabs
        cancelEarly = true;
      }
      // we decided to cancel the request at this point, register canceled
      // request
      this.canceledRequests[tab.id].requestIds[options.requestId] = true;
      this.canceledRequests[tab.id].urls[options.url] = true;
      if (cancelEarly) {
        return {
          cancel: true
        };
      }
    }

    if (siteIsolatedReloadInDefault) {
      this.reloadPageInDefaultContainer(
        options.url,
        tab.index + 1,
        tab.active,
        openTabId
      );
    } else {
      this.reloadPageInContainer(
        options.url,
        currentUserContextId,
        siteSettings.userContextIds,
        tab.index + 1,
        tab.active,
        siteSettings.neverAsk,
        openTabId
      );
    }
    this.calculateContextMenu(tab);

    /* Removal of existing tabs:
        We aim to open the new assigned container tab / warning prompt in
        it's own tab:
          - As the history won't span from one container to another it
            seems most sane to not try and reopen a tab on history.back()
          - When users open a new tab themselves we want to make sure we
            don't end up with three tabs as per:
            https://github.com/mozilla/testpilot-containers/issues/421
        If we are coming from an internal url that are used for the new
        tab page (NEW_TAB_PAGES), we can safely close as user is unlikely
        losing history
        Detecting redirects on "new tab" opening actions is pretty hard
        as we don't get tab history:
        - Redirects happen from Short URLs and tracking links that act as
          a gateway
        - Extensions don't provide a way to history crawl for tabs, we
          could inject content scripts to do this
            however they don't run on about:blank so this would likely be
            just as hacky.
        We capture the time the tab was created and close if it was within
        the timeout to try to capture pages which haven't had user
        interaction or history.
    */
    if (removeTab) {
      browser.tabs.remove(tab.id);
    }
    return {
      cancel: true,
    };
  },

  async _maybeSiteIsolatedReloadInDefault(siteSettings, tab) {
    // Tab doesn't support cookies, so containers not supported either.
    if (!("cookieStoreId" in tab)) {
      return false;
    }

    // Requested page has been assigned to a specific container.
    // I.e. it will be opened in that container anyway, so we don't need to check if the
    // current tab's container is locked or not.
    if (siteSettings) {
      return false;
    }

    //tab is alredy reopening in the default container
    if (tab.cookieStoreId === "firefox-default") {
      return false;
    }
    // Requested page is not assigned to a specific container. If the current tab's container
    // is locked, then the page must be reloaded in the default container.
    const currentContainerState = await identityState.storageArea.get(tab.cookieStoreId);
    return currentContainerState && currentContainerState.isIsolated;
  },

  maybeAddProxyListeners() {
    if (browser.proxy) {
      browser.proxy.onRequest.addListener(this.handleProxifiedRequest, {urls: ["<all_urls>"]});
    }
  },

  init() {
    browser.contextMenus.onClicked.addListener((info, tab) => {
      info.bookmarkId ?
        this._onClickedBookmark(info) :
        this._onClickedHandler(info, tab);
    });

    // Before anything happens we decide if the request should be proxified
    this.maybeAddProxyListeners();

    // Before a request is handled by the browser we decide if we should
    // route through a different container
    this.canceledRequests = {};
    browser.webRequest.onBeforeRequest.addListener((options) => {
      return this.onBeforeRequest(options);
    },{urls: ["<all_urls>"], types: ["main_frame"]}, ["blocking"]);

    // Clean up canceled requests
    browser.webRequest.onCompleted.addListener((options) => {
      if (this.canceledRequests[options.tabId]) {
        delete this.canceledRequests[options.tabId];
      }
    },{urls: ["<all_urls>"], types: ["main_frame"]});
    browser.webRequest.onErrorOccurred.addListener((options) => {
      if (this.canceledRequests[options.tabId]) {
        delete this.canceledRequests[options.tabId];
      }
    },{urls: ["<all_urls>"], types: ["main_frame"]});

    this.resetBookmarksMenuItem();
  },

  async resetBookmarksMenuItem() {
    const hasPermission = await browser.permissions.contains({
      permissions: ["bookmarks"]
    });
    if (this.hadBookmark === hasPermission) {
      return;
    }
    this.hadBookmark = hasPermission;
    if (hasPermission) {
      this.initBookmarksMenu();
      browser.contextualIdentities.onCreated
        .addListener(this.contextualIdentityCreated);
      browser.contextualIdentities.onUpdated
        .addListener(this.contextualIdentityUpdated);
      browser.contextualIdentities.onRemoved
        .addListener(this.contextualIdentityRemoved);
    } else {
      this.removeBookmarksMenu();
      browser.contextualIdentities.onCreated
        .removeListener(this.contextualIdentityCreated);
      browser.contextualIdentities.onUpdated
        .removeListener(this.contextualIdentityUpdated);
      browser.contextualIdentities.onRemoved
        .removeListener(this.contextualIdentityRemoved);
    }
  },

  contextualIdentityCreated(changeInfo) {
    browser.contextMenus.create({
      parentId: assignManager.OPEN_IN_CONTAINER,
      id: changeInfo.contextualIdentity.cookieStoreId,
      title: changeInfo.contextualIdentity.name,
      icons: { "16": `img/usercontext.svg#${
        changeInfo.contextualIdentity.icon
      }` }
    });
  },

  contextualIdentityUpdated(changeInfo) {
    browser.contextMenus.update(
      changeInfo.contextualIdentity.cookieStoreId, {
        title: changeInfo.contextualIdentity.name,
        icons: { "16": `img/usercontext.svg#${
          changeInfo.contextualIdentity.icon}` }
      });
  },

  contextualIdentityRemoved(changeInfo) {
    browser.contextMenus.remove(
      changeInfo.contextualIdentity.cookieStoreId
    );
  },

  async _onClickedHandler(info, tab) {
    const userContextId = this.getUserContextIdFromCookieStore(tab);
    // Mapping ${URL(info.pageUrl).hostname} to ${userContextId}
    let remove;
    if (userContextId) {
      switch (info.menuItemId) {
      case this.MENU_ASSIGN_ID:
      case this.MENU_REMOVE_ID:
        if (info.menuItemId === this.MENU_ASSIGN_ID) {
          remove = false;
        } else {
          remove = true;
        }
        await this._setOrRemoveAssignment(
          tab.id, info.pageUrl, userContextId, remove
        );
        break;
      case this.MENU_MOVE_ID:
        backgroundLogic.moveTabsToWindow({
          cookieStoreId: tab.cookieStoreId,
          windowId: tab.windowId,
        });
        break;
      case this.MENU_HIDE_ID:
        backgroundLogic.hideTabs({
          cookieStoreId: tab.cookieStoreId,
          windowId: tab.windowId,
        });
        break;
      }
    }
  },

  async _onClickedBookmark(info) {

    async function _getBookmarksFromInfo(info) {
      const [bookmarkTreeNode] =
        await browser.bookmarks.get(info.bookmarkId);
      if (bookmarkTreeNode.type === "folder") {
        return browser.bookmarks.getChildren(bookmarkTreeNode.id);
      }
      return [bookmarkTreeNode];
    }

    const bookmarks = await _getBookmarksFromInfo(info);
    for (const bookmark of bookmarks) {
      // Some checks on the urls from
      // https://github.com/Rob--W/bookmark-container-tab/ thanks!
      if ( !/^(javascript|place):/i.test(bookmark.url) &&
          bookmark.type !== "folder") {
        const openInReaderMode = bookmark.url.startsWith("about:reader");
        if(openInReaderMode) {
          try {
            const parsed = new URL(bookmark.url);
            bookmark.url = parsed.searchParams.get("url") + parsed.hash;
          } catch (err) {
            return err.message;
          }
        }
        browser.tabs.create({
          cookieStoreId: info.menuItemId,
          url: bookmark.url,
          openInReaderMode: openInReaderMode
        });
      }
    }
  },


  deleteContainer(userContextId) {
    this.storageArea.deleteContainer(userContextId);
  },

  getUserContextIdFromCookieStore(tab) {
    if (!("cookieStoreId" in tab)) {
      return false;
    }
    return backgroundLogic.getUserContextIdFromCookieStoreId(
      tab.cookieStoreId
    );
  },

  isTabPermittedAssign(tab) {
    // Ensure we are not an important about url
    const url = new URL(tab.url);
    if (url.protocol === "about:"
        || url.protocol === "moz-extension:") {
      return false;
    }
    return true;
  },

  async _setOrRemoveAssignment(tabId, pageUrl, userContextId, remove) {
    let actionName;
    // https://github.com/mozilla/testpilot-containers/issues/626
    // Context menu has stored context IDs as strings, so we need to coerce
    // the value to a string for accurate checking
    userContextId = String(userContextId);
    let siteSettings = await this.storageArea.get(pageUrl);

    if (!remove) {
      const tabs = await browser.tabs.query({});
      const assignmentStoreKey = this.storageArea.getSiteStoreKey(pageUrl);
      const exemptedTabIds = tabs.filter((tab) => {
        const tabStoreKey = this.storageArea.getSiteStoreKey(tab.url);
        /* Auto exempt all tabs that exist for this hostname that are not in the same container */
        if (tabStoreKey === assignmentStoreKey &&
            this.getUserContextIdFromCookieStore(tab) !== userContextId) {
          return true;
        }
        return false;
      }).map((tab) => {
        return tab.id;
      });

      if (!siteSettings) {
        siteSettings = { userContextIds: [userContextId], neverAsk: false };
      } else if (!siteSettings.userContextIds.includes(userContextId)) {
        siteSettings.userContextIds.push(userContextId);
      }
      await this.storageArea.set(pageUrl, siteSettings, exemptedTabIds);
      actionName = "assigned site to always open in this container";
    } else {
      if (siteSettings) {
        siteSettings.userContextIds = siteSettings.userContextIds.filter(
          id => id !== userContextId
        );
        if (siteSettings.neverAsk === userContextId) {
          siteSettings.neverAsk = false;
        }
        if (!siteSettings.userContextIds.length) {
          await this.storageArea.remove(pageUrl);
        } else {
          await this.storageArea.set(pageUrl, siteSettings);
        }
      }

      actionName = "removed from assigned sites list";

      // remove site isolation if now empty
      await this._maybeRemoveSiteIsolation(userContextId);
    }

    if (tabId) {
      const tab = await browser.tabs.get(tabId);
      setTimeout(function(){
        browser.tabs.sendMessage(tabId, {
          text: `Successfully ${actionName}`
        });
      }, 1000);


      this.calculateContextMenu(tab);
    }
  },

  async _maybeRemoveSiteIsolation(userContextId) {
    const assignments = await this.storageArea.getAssignedSites(userContextId);
    const hasAssignments = assignments && Object.keys(assignments).length > 0;
    if (hasAssignments) {
      return;
    }
    await backgroundLogic.addRemoveSiteIsolation(
      backgroundLogic.cookieStoreId(userContextId),
      true
    );
  },

  async _getAssignment(tab) {
    const cookieStore = this.getUserContextIdFromCookieStore(tab);
    // Ensure we have a cookieStore to assign to
    if (cookieStore
        && this.isTabPermittedAssign(tab)) {
      return this.storageArea.get(tab.url);
    }
    return false;
  },

  _getByContainer(userContextId) {
    return this.storageArea.getAssignedSites(userContextId);
  },

  removeContextMenu() {
    // There is a focus issue in this menu where if you change window with a context menu click
    // you get the wrong menu display because of async
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1215376#c16
    // We also can't change for always private mode
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1352102
    browser.contextMenus.remove(this.MENU_ASSIGN_ID);
    browser.contextMenus.remove(this.MENU_REMOVE_ID);
    browser.contextMenus.remove(this.MENU_SEPARATOR_ID);
    browser.contextMenus.remove(this.MENU_HIDE_ID);
    browser.contextMenus.remove(this.MENU_MOVE_ID);
  },

  async calculateContextMenu(tab) {
    this.removeContextMenu();
    const siteSettings = await this._getAssignment(tab);
    // Return early and not add an item if we have false
    // False represents assignment is not permitted
    if (siteSettings === false) {
      return false;
    }
    let checked = false;
    let menuId = this.MENU_ASSIGN_ID;
    const tabUserContextId = this.getUserContextIdFromCookieStore(tab);
    if (siteSettings &&
        siteSettings.userContextIds.includes(tabUserContextId)) {
      checked = true;
      menuId = this.MENU_REMOVE_ID;
    }
    browser.contextMenus.create({
      id: menuId,
      title: browser.i18n.getMessage("alwaysOpenSiteInContainer"),
      checked,
      type: "checkbox",
      contexts: ["all"],
    });

    browser.contextMenus.create({
      id: this.MENU_SEPARATOR_ID,
      type: "separator",
      contexts: ["all"],
    });

    browser.contextMenus.create({
      id: this.MENU_HIDE_ID,
      title: browser.i18n.getMessage("hideThisContainer"),
      contexts: ["all"],
    });

    browser.contextMenus.create({
      id: this.MENU_MOVE_ID,
      title: browser.i18n.getMessage("moveTabsToANewWindow"),
      contexts: ["all"],
    });
  },

  encodeURLProperty(url) {
    return encodeURIComponent(url).replace(/[!'()*]/g, (c) => {
      const charCode = c.charCodeAt(0).toString(16);
      return `%${charCode}`;
    });
  },

  reloadPageInDefaultContainer(url, index, active, openerTabId) {
    // To create a new tab in the default container, it is easiest just to omit the
    // cookieStoreId entirely.
    //
    // Unfortunately, if you create a new tab WITHOUT a cookieStoreId but WITH an openerTabId,
    // then the new tab automatically inherits the opener tab's cookieStoreId.
    // I.e. it opens in the wrong container!
    //
    // So we have to explicitly pass in a cookieStoreId when creating the tab, since we
    // are specifying the openerTabId. There doesn't seem to be any way
    // to look up the default container's cookieStoreId programatically, so sadly
    // we have to hardcode it here as "firefox-default". This is potentially
    // not cross-browser compatible.
    //
    // Note that we could have just omitted BOTH cookieStoreId and openerTabId. But the
    // drawback then is that if the user later closes the newly-created tab, the browser
    // does not automatically return to the original opener tab. To get this desired behaviour,
    // we MUST specify the openerTabId when creating the new tab.
    const cookieStoreId = "firefox-default";
    browser.tabs.create({url, cookieStoreId, index, active, openerTabId});
  },

  reloadPageInContainer(url, currentUserContextId, userContextIdList, index, active, neverAsk = false, openerTabId = null) {
    // False represents assignment is not permitted
    // If the user has explicitly checked "Never Ask Again" on the warning page we will send them straight there
    if (neverAsk) {
      const cookieStoreId = backgroundLogic.cookieStoreId(neverAsk);
      return browser.tabs.create({url, cookieStoreId, index, active, openerTabId});
    } else {
      const loadPage = browser.runtime.getURL("confirm-page.html");
      const cookieStoreIds = [];
      for (const userContextId of userContextIdList) {
        cookieStoreIds.push(backgroundLogic.cookieStoreId(userContextId));
      }
      let confirmUrl = `${loadPage}?url=${this.encodeURLProperty(url)}&cookieStoreIds=${cookieStoreIds.join(",")}`;
      let currentCookieStoreId;
      if (currentUserContextId) {
        currentCookieStoreId = backgroundLogic.cookieStoreId(currentUserContextId);
        confirmUrl += `&currentCookieStoreId=${currentCookieStoreId}`;
      }
      return browser.tabs.create({
        url: confirmUrl,
        cookieStoreId: currentCookieStoreId,
        openerTabId,
        index,
        active
      }).then(() => {
        // We don't want to sync this URL ever nor clutter the users history
        browser.history.deleteUrl({url: confirmUrl});
      }).catch((e) => {
        throw e;
      });
    }
  },

  async initBookmarksMenu() {
    browser.contextMenus.create({
      id: this.OPEN_IN_CONTAINER,
      title: "Open Bookmark in Container Tab",
      contexts: ["bookmark"],
    });

    const identities = await browser.contextualIdentities.query({});
    for (const identity of identities) {
      browser.contextMenus.create({
        parentId: this.OPEN_IN_CONTAINER,
        id: identity.cookieStoreId,
        title: identity.name,
        icons: { "16": `img/usercontext.svg#${identity.icon}` }
      });
    }
  },

  async removeBookmarksMenu() {
    browser.contextMenus.remove(this.OPEN_IN_CONTAINER);
    const identities = await browser.contextualIdentities.query({});
    for (const identity of identities) {
      browser.contextMenus.remove(identity.cookieStoreId);
    }
  },
};

assignManager.init();
