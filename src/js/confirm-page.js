async function load() {
  const searchParams = new URL(window.location).searchParams;
  const redirectUrl = searchParams.get("url");
  const cookieStoreIds = searchParams.get("cookieStoreIds").split(",");
  const currentCookieStoreId = searchParams.get("currentCookieStoreId");
  const redirectUrlElement = document.getElementById("redirect-url");
  redirectUrlElement.textContent = redirectUrl;
  appendFavicon(redirectUrl, redirectUrlElement);

  document.getElementById("deny").addEventListener("click", (e) => {
    e.preventDefault();
    denySubmit(redirectUrl);
  });

  document.getElementById("deny-no-container").addEventListener("click", (e) => {
    e.preventDefault();
    denySubmit(redirectUrl);
  });

  const containers = await Promise.all(
    cookieStoreIds.map(id => browser.contextualIdentities.get(id))
  );
  const currentContainer = currentCookieStoreId ? await browser.contextualIdentities.get(currentCookieStoreId) : null;
  const currentContainerName = currentContainer ? setDenyButton(currentContainer.name) : setDenyButton("");
  const allContainerNames = containers.map(container => container.name).join(", ");

  document.querySelectorAll("[data-message-id]").forEach(el => {
    const elementData = el.dataset;
    const containerName = elementData.messageArg === "all-container-names" ? allContainerNames : currentContainerName;
    el.textContent = browser.i18n.getMessage(elementData.messageId, containerName);
  });

  const firstContainerButton = document.getElementById("confirm");
  const openMessageId = firstContainerButton.dataset.messageId;
  firstContainerButton.textContent = browser.i18n.getMessage(openMessageId, containers[0].name);
  firstContainerButton.addEventListener("click", (e) => {
    e.preventDefault();
    confirmSubmit(redirectUrl, cookieStoreIds[0]);
  });

  const buttonContainer = firstContainerButton.parentNode;
  for (const [containerName, cookieStoreId] of containers.map(
    (container, idx) => [container.name, cookieStoreIds[idx]]).slice(1)
  ) {
    const extraContainerButton = document.createElement("button");
    extraContainerButton.classList.add("button", "primary");
    extraContainerButton.textContent = browser.i18n.getMessage(openMessageId, containerName);
    extraContainerButton.addEventListener("click", (e) => {
      e.preventDefault();
      confirmSubmit(redirectUrl, cookieStoreId);
    });
    buttonContainer.append(extraContainerButton);
  }
}

function setDenyButton(currentContainerName) {
  const buttonDeny = document.getElementById("deny");
  const buttonDenyNoContainer = document.getElementById("deny-no-container");

  if (currentContainerName) {
    buttonDenyNoContainer.style.display = "none";
    return currentContainerName;
  }
  buttonDeny.style.display = "none";
  return;
}

function appendFavicon(pageUrl, redirectUrlElement) {
  const origin = new URL(pageUrl).origin;
  const favIconElement = Utils.createFavIconElement(`${origin}/favicon.ico`);

  redirectUrlElement.prepend(favIconElement);
}

function confirmSubmit(redirectUrl, cookieStoreId) {
  const neverAsk = document.getElementById("never-ask").checked;
  // Sending neverAsk message to background to store for next time we see this process
  if (neverAsk) {
    browser.runtime.sendMessage({
      method: "neverAsk",
      neverAsk: true,
      pageUrl: redirectUrl
    });
  }
  openInContainer(redirectUrl, cookieStoreId);
}

function getCurrentTab() {
  return browser.tabs.query({
    active: true,
    windowId: browser.windows.WINDOW_ID_CURRENT
  });
}

async function denySubmit(redirectUrl) {
  const tab = await getCurrentTab();
  await browser.runtime.sendMessage({
    method: "exemptContainerAssignment",
    tabId: tab[0].id,
    pageUrl: redirectUrl
  });
  document.location.replace(redirectUrl);
}

load();

async function openInContainer(redirectUrl, cookieStoreId) {
  const tab = await getCurrentTab();
  await browser.tabs.create({
    index: tab[0].index + 1,
    cookieStoreId,
    url: redirectUrl
  });
  if (tab.length > 0) {
    browser.tabs.remove(tab[0].id);
  }
}
