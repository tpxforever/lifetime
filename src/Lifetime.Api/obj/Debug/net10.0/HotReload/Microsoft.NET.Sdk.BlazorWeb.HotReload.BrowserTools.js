// Hot Reload browser tools client.
//
// This module is part of the application build output. It must never be downloaded from the
// Hot Reload provider: the provider is the party this client authenticates, so executable code
// served by it could not be trusted. The generated configuration module pins the provider's public
// key at build time and passes it to startBrowserTools.

const hotReloadActiveKey = '_dotnet_watch_hot_reload_active';
// Ensures we only connect once even when several activation paths import this module.
const scriptInjectedSentinel = '_dotnet_watch_ws_injected';
const replayResponseLoggingLevel = 1;
const AgentMessageSeverity_Warning = 1;
const AgentMessageSeverity_Error = 2;
// Bounds how long the replay waits for the Hot Reload agent. Only spent when there is something to
// replay and the apply API is still missing, which is the case that would otherwise lose updates.
const hotReloadAgentReadyTimeoutMs = 10000;
const browserToolsStyles = `
  :host {
    z-index: 1000000;
    position: fixed;
  }

  :host(#dotnet-compile-error) {
    inset: 0;
    background-color: rgba(0, 0, 0, 0.5);
    color: black;
    overflow: scroll;
  }

  .dotnet-compile-error-item {
    border: 2px solid red;
    padding: 8px;
    background-color: #faa;
  }

  .dotnet-compile-error-message {
    font-weight: bold;
  }

  :host(#dotnet-hotreload-toast) {
    width: 48px;
    height: 48px;
    top: 5px;
    left: 5px;
  }

  svg {
    filter: drop-shadow(0 2px 1px rgb(0 0 0 / 0.4));
  }

  #hotreloaded-ellipse1 {
    animation: hotreloaded-ellipse1_c_o 1800ms linear 1 normal forwards;
  }

  #hotreloaded-path1 {
    animation-name: hotreloaded-path1__m, hotreloaded-path1_c_o;
    animation-duration: 1800ms;
    animation-delay: 100ms;
    animation-fill-mode: forwards;
    animation-timing-function: linear;
    animation-direction: normal;
    animation-iteration-count: 1;
  }

  @keyframes hotreloaded-ellipse1_c_o {
    0% { opacity: 0; }
    16.666667% { opacity: 1; }
    72.222222% { opacity: 1; }
    90% { opacity: 0; }
    100% { opacity: 0; }
  }

  @keyframes hotreloaded-path1__m {
    0% { d: path('M126.151214,288.396852L196.625037,350.661591L320.793323,178.518242'); }
    16.666667% { d: path('M126.151214,288.396852L126.151214,288.396852L126.151214,288.396852'); }
    22.222222% {
      d: path('M126.151214,288.396852L196.625037,350.661591L196.625037,350.661591');
      animation-timing-function: cubic-bezier(0.42, 0, 0.58, 1);
    }
    33.333333% { d: path('M126.151214,288.396852L196.625037,350.661591L320.793323,178.518242'); }
    100% { d: path('M126.151214,288.396852L196.625037,350.661591L320.793323,178.518242'); }
  }

  @keyframes hotreloaded-path1_c_o {
    0% { opacity: 0; }
    16.666667% { opacity: 0; }
    22.222222% { opacity: 1; }
    72.222222% { opacity: 1; }
    90% { opacity: 0; }
    100% { opacity: 0; }
  }
`;
let browserToolsStylesheet;

/**
 * Connects to the Hot Reload browser tools provider.
 *
 * @param {object} config Build-generated configuration.
 * @param {string} config.publicKey Base64 SubjectPublicKeyInfo of the provider's session key.
 * @param {string} config.connectPath Root-relative route of the provider's WebSocket endpoint.
 * @param {string} config.clearCachePath Root-relative route of the provider's cache reset endpoint.
 * @param {string} config.moduleUrl URL of the generated configuration module. Polled to detect that
 *                                  the application is reachable again after it restarted.
 */
export async function startBrowserTools(config) {
  if (window.hasOwnProperty(scriptInjectedSentinel)) {
    return;
  }
  window[scriptInjectedSentinel] = true;

  const { publicKey, connectPath, clearCachePath, moduleUrl } = config;

  const sharedSecret = await getSecret(publicKey);
  if (!sharedSecret) {
    delete window[scriptInjectedSentinel];
    console.debug('Unable to protect the Hot Reload browser tools connection. Browser tools are disabled.');
    return;
  }

  const connectUrl = new URL(connectPath, document.baseURI);
  connectUrl.protocol = connectUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  let closing = false;
  let waiting = false;

  // The provider sends the session initialization message, which carries the updates produced
  // before this browser connected, as the first message on the socket. It releases live messages
  // for this connection only after the browser acknowledges that message, so chaining the live
  // message queue on the initialization promise preserves the order even if a live message somehow
  // arrives early.
  let completeInitialization;
  let failInitialization;
  const initialized = new Promise((resolve, reject) => { completeInitialization = resolve; failInitialization = reject; });
  initialized.catch(() => { });

  let initializationMessageReceived = false;
  let receiveInitializationMessage;
  const initializationMessage = new Promise(resolve => receiveInitializationMessage = resolve);
  let messageQueue = initialized;

  let connection;
  try {
    connection = await getWebSocket(connectUrl, sharedSecret.encryptedSharedSecret, message => {
      if (!initializationMessageReceived) {
        initializationMessageReceived = true;
        receiveInitializationMessage(message);
      } else {
        messageQueue = messageQueue
          .then(() => handleMessage(message))
          .catch(error => console.debug('Failed to process a browser refresh message.', error));
      }
    });
  } catch (ex) {
    console.debug(ex);
  }

  if (!connection) {
    delete window[scriptInjectedSentinel];
    console.debug('Unable to establish a connection to the browser refresh server.');
    return;
  }

  connection.onerror = function (event) { console.debug('Hot Reload socket error.', event) }
  connection.onclose = function () {
    delete window[scriptInjectedSentinel];
    failInitialization('The browser tools connection was closed.');
    console.debug('Hot Reload socket closed.');
    if (!closing) {
      // The browser reaches the provider through the application, so the socket dies when the
      // application restarts and any pending Reload message is lost. Reload once it is back.
      reloadWhenApplicationReturns();
    }
  }

  if (await initializeSession()) {
    completeInitialization();

    const agent = hotReloadAgentSignal();
    agent.ready.then(() => {
      const updates = agent.pendingUpdates;
      delete agent.pendingUpdates;
      if (!updates) {
        return;
      }

      if (updates.length && !hasDeltaApplyApi()) {
        console.error('Unable to apply deferred Hot Reload updates because the WebAssembly Hot Reload agent is unavailable.');
        return;
      }

      for (const update of updates) {
        try {
          const log = applyDeltas(update.deltas, update.responseLoggingLevel);
          for (const entry of log) {
            if (entry.severity === AgentMessageSeverity_Error) {
              console.error(entry.message);
            } else if (entry.severity === AgentMessageSeverity_Warning) {
              console.warn(entry.message);
            } else {
              console.debug(entry.message);
            }
          }
        } catch (error) {
          console.error('Unable to apply deferred Hot Reload updates.', error);
        }
      }
    });
  } else {
    closing = true;
    connection.close();
  }

  async function initializeSession() {
    let payload;
    try {
      payload = JSON.parse((await withTimeout(initializationMessage, 30000)).data);
    } catch (error) {
      console.debug('Unable to initialize the browser tools session.', error);
      return false;
    }

    if (payload.type !== 'InitializeSession') {
      console.error(`Expected the browser tools session initialization message but received '${payload.type}'.`);
      return false;
    }

    if (!authenticateProvider(payload.sharedSecret)) {
      console.error('Unable to validate the browser refresh server. Closing the connection.');
      return false;
    }

    const log = [];
    let applyError;
    try {
      const updates = payload.updates ?? [];
      if (updates.length && !hotReloadAgentSignal().pendingUpdates && !(await waitForDeltaApplyApi())) {
        // Keep initializing: the connection is still useful for reloads, diagnostics and CSS, and
        // failing here would close the socket and reload the page into the same state. Surface the
        // condition in the Hot Reload console instead.
        log.push({
          "message": 'The Hot Reload agent did not become available in time, so the updates produced before this browser connected were not applied.',
          "severity": AgentMessageSeverity_Warning
        });
      }

      for (const update of updates) {
        try {
          const entries = applyDeltas(update.deltas, replayResponseLoggingLevel);
          if (entries && entries.length) {
            log.push(...entries);
          }
        } catch (error) {
          // Report the failure without failing the initialization, for the same reason as above:
          // Hot Reload prints these entries as errors, while closing the socket would only make
          // the page reload into a browser that cannot apply updates either.
          console.warn('Unable to replay Hot Reload updates.', error);
          log.push({ "message": getMessageAndStack(error), "severity": AgentMessageSeverity_Error });
        }
      }
    } catch (error) {
      console.warn('Unable to initialize the browser tools session.', error);
      applyError = error;
      log.push({ "message": getMessageAndStack(error), "severity": AgentMessageSeverity_Error });
    }

    connection.send(JSON.stringify({ "success": !applyError, "log": log }));
    return !applyError;
  }

  async function handleMessage(message) {
    const payload = JSON.parse(message.data);
    const action = {
      'Reload': () => reload(),
      'Wait': () => wait(),
      'UpdateStaticFile': () => updateStaticFile(payload.path),
      'ApplyManagedCodeUpdates': () => applyManagedCodeUpdates(payload.sharedSecret, payload.deltas, payload.responseLoggingLevel),
      'ReportDiagnostics': () => reportDiagnostics(payload.diagnostics),
      'RefreshBrowser': () => refreshBrowser()
    };

    if (payload.type && action.hasOwnProperty(payload.type)) {
      await action[payload.type]();
    } else {
      console.error('Unknown payload:', message.data);
    }
  }

  // The provider proves it decrypted the secret this browser generated, which is only possible for
  // the process holding the private key matching the build-pinned public key.
  function authenticateProvider(providerSecret) {
    return providerSecret === sharedSecret.encodedSharedSecret;
  }

  async function reloadWhenApplicationReturns() {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        const response = await fetch(moduleUrl, { cache: 'no-store' });
        if (response.ok) {
          location.reload();
          return;
        }
      } catch (error) {
        // The application is still restarting.
      }
    }
  }

  function updateStaticFile(path) {
    if (path && path.endsWith('.css')) {
      updateCssByPath(path);
    } else {
      console.debug(`File change detected to file ${path}. Reloading page...`);
      location.reload();
      return;
    }
  }

  async function updateCssByPath(path) {
    const styleElement = document.querySelector(`link[href^="${path}"]`) ||
      document.querySelector(`link[href^="${document.baseURI}${path}"]`);

    // Receive a Clear-site-data header.
    await fetch(new URL(clearCachePath, document.baseURI), { cache: 'no-store' });

    if (!styleElement || !styleElement.parentNode) {
      console.debug('Unable to find a stylesheet to update. Updating all local css files.');
      updateAllLocalCss();
    }

    updateCssElement(styleElement);
  }

  function updateAllLocalCss() {
    [...document.querySelectorAll('link')]
      .filter(l => l.baseURI === document.baseURI)
      .forEach(e => updateCssElement(e));
  }

  function updateCssElement(styleElement) {
    if (!styleElement || styleElement.loading) {
      // A file change notification may be triggered for the same file before the browser
      // finishes processing a previous update. In this case, it's easiest to ignore later updates
      return;
    }

    const newElement = styleElement.cloneNode();
    const href = styleElement.href;
    newElement.href = href.split('?', 1)[0] + `?nonce=${Date.now()}`;

    styleElement.loading = true;
    newElement.loading = true;
    newElement.addEventListener('load', function () {
      newElement.loading = false;
      styleElement.remove();
    });

    styleElement.parentNode.insertBefore(newElement, styleElement.nextSibling);
  }

  function applyDeltas_legacy(deltas) {
    let apply = window.Blazor?._internal?.applyHotReload

    // Only apply hot reload deltas if Blazor has been initialized.
    // It's possible for Blazor to start after the initial page load, so we don't consider skipping this step
    // to be a failure. These deltas will get applied later, when Blazor completes initialization.
    if (apply) {
      deltas.forEach(d => {
        if (apply.length == 5) {
          // WASM 8.0
          apply(d.moduleId, d.metadataDelta, d.ilDelta, d.pdbDelta, d.updatedTypes)
        } else {
          // WASM 9.0
          apply(d.moduleId, d.metadataDelta, d.ilDelta, d.pdbDelta)
        }
      });
    }
  }

  function applyDeltas(deltas, responseLoggingLevel) {
    const agent = hotReloadAgentSignal();
    if (agent.pendingUpdates) {
      agent.pendingUpdates.push({ deltas, responseLoggingLevel });
      console.debug('Managed code updates deferred until WebAssembly starts.');
      return [];
    }

    let applyDeltas = agent.applyHotReloadDeltas ?? window.Blazor?._internal?.applyHotReloadDeltas
    if (applyDeltas) {
      // Only apply hot reload deltas if Blazor has been initialized.
      // It's possible for Blazor to start after the initial page load, so we don't consider skipping this step
      // to be a failure. These deltas will get applied later, when Blazor completes initialization.

      let wasmDeltas = deltas.map(delta => {
        return {
          "moduleId": delta.moduleId,
          "metadataDelta": delta.metadataDelta,
          "ilDelta": delta.ilDelta,
          "pdbDelta": delta.pdbDelta,
          "updatedTypes": delta.updatedTypes,
        };
      });

      return applyDeltas(wasmDeltas, responseLoggingLevel);
    }

    // Try invoke older WASM API:
    applyDeltas_legacy(deltas)
    return [];
  }

  function applyManagedCodeUpdates(providerSecret, deltas, responseLoggingLevel) {
    if (!authenticateProvider(providerSecret)) {
      throw 'Unable to validate the server. Rejecting apply-update payload.';
    }

    console.debug('Applying managed code updates.');

    let applyError = undefined;
    let log = [];
    try {
      log = applyDeltas(deltas, responseLoggingLevel);
    } catch (error) {
      console.warn(error);
      applyError = error;
      log.push({ "message": getMessageAndStack(error), "severity": AgentMessageSeverity_Error });
    }

    connection.send(JSON.stringify({
      "success": !applyError,
      "log": log
    }));

    if (!applyError) {
      displayChangesAppliedToast();
    }
  }

  function reportDiagnostics(diagnostics) {
    console.debug('Reporting Hot Reload diagnostics.');

    document.querySelectorAll('#dotnet-compile-error').forEach(el => el.remove());

    if (diagnostics.length == 0) {
      return;
    }

    const { host: el, root } = createBrowserToolsHost('dotnet-compile-error');
    document.body.appendChild(el);
    diagnostics.forEach(error => {
      const item = root.appendChild(document.createElement('div'));
      item.className = 'dotnet-compile-error-item';
      const message = item.appendChild(document.createElement('div'));
      message.className = 'dotnet-compile-error-message';
      message.textContent = error.Message;
      item.appendChild(document.createElement('div')).textContent = error;
    });
  }

  function displayChangesAppliedToast() {
    document.querySelectorAll('#dotnet-compile-error').forEach(el => el.remove());
    if (document.querySelector('#dotnet-hotreload-toast')) {
      return;
    }
    if (!window[hotReloadActiveKey])
    {
        return;
    }
    const { host: el, root } = createBrowserToolsHost('dotnet-hotreload-toast');
    root.appendChild(createHotReloadToastIcon());
    document.body.appendChild(el);
    window[hotReloadActiveKey] = false;
    setTimeout(() => el.remove(), 2000);
  }

  function createHotReloadToastIcon() {
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('viewBox', '0 0 500 500');

    const ellipse = svg.appendChild(document.createElementNS(svgNamespace, 'ellipse'));
    ellipse.id = 'hotreloaded-ellipse1';
    ellipse.setAttribute('rx', '212.808853');
    ellipse.setAttribute('ry', '205.404598');
    ellipse.setAttribute('transform', 'matrix(0.982102 0 0 1.017504 251 238)');
    ellipse.setAttribute('opacity', '0');
    ellipse.setAttribute('fill', 'rgb(120,120,120)');

    const path = svg.appendChild(document.createElementNS(svgNamespace, 'path'));
    path.id = 'hotreloaded-path1';
    path.setAttribute('d', 'M126.151214,288.396852L196.625037,350.661591L320.793323,178.518242');
    path.setAttribute('transform', 'matrix(1 0 0 1 27.527732 -26.589916)');
    path.setAttribute('opacity', '0');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'rgb(255,255,255)');
    path.setAttribute('stroke-width', '40');
    path.setAttribute('stroke-linecap', 'round');
    return svg;
  }

  function createBrowserToolsHost(id) {
    const host = document.createElement('div');
    host.id = id;
    const root = host.attachShadow({ mode: 'open' });
    if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function') {
      if (!browserToolsStylesheet) {
        browserToolsStylesheet = new CSSStyleSheet();
        browserToolsStylesheet.replaceSync(browserToolsStyles);
      }

      root.adoptedStyleSheets = [browserToolsStylesheet];
    }

    return { host, root };
  }

  function refreshBrowser() {
    if (window.Blazor) {
      window[hotReloadActiveKey] = true;
      // hotReloadApplied triggers an enhanced navigation to
      // refresh pages that have been statically rendered with
      // Blazor SSR.
      if (window.Blazor?._internal?.hotReloadApplied)
      {
        console.debug('Refreshing browser: WASM.');
        Blazor._internal.hotReloadApplied();
      }
      else
      {
        console.debug('Refreshing browser.');
        displayChangesAppliedToast();
      }
    } else {
      console.debug('Refreshing browser: Reloading.');
      location.reload();
    }
  }

  function reload() {
    console.debug('Reloading.');
    location.reload();
  }

  function wait() {
    console.debug('Waiting for application to rebuild.');

    if (waiting) {
      return;
    }

    waiting = true;
    const glyphs = ['☱', '☲', '☴'];
    const title = document.title;
    let i = 0;
    setInterval(function () { document.title = glyphs[i++ % glyphs.length] + ' ' + title; }, 240);
  }

  function getWebSocket(url, encryptedSecret, onMessage) {
    return new Promise((resolve, reject) => {
      const webSocket = new WebSocket(url, encodeURIComponent(encryptedSecret));
      let opened = false;

      // Listen for messages before the socket opens so that the session initialization message,
      // which the provider sends first, can never be missed.
      webSocket.addEventListener('message', onMessage);

      function onOpen() {
        opened = true;
        clearEventListeners();
        resolve(webSocket);
      }

      function onClose(event) {
        if (opened) {
          // Open completed successfully. Nothing to do here.
          return;
        }

        let error = 'WebSocket failed to connect.';
        if (event instanceof ErrorEvent) {
          error = event.error;
        }

        clearEventListeners();
        reject(error);
      }

      function clearEventListeners() {
        webSocket.removeEventListener('open', onOpen);
        // The error event isn't as reliable, but close is always called even during failures.
        // If close is called without a corresponding open, we can reject the promise.
        webSocket.removeEventListener('close', onClose);
      }

      webSocket.addEventListener('open', onOpen);
      webSocket.addEventListener('close', onClose);
      if (window.Blazor?.removeEventListener && window.Blazor?.addEventListener)
      {
        webSocket.addEventListener('close', () => window.Blazor?.removeEventListener('enhancedload', displayChangesAppliedToast));
        window.Blazor?.addEventListener('enhancedload', displayChangesAppliedToast);
      }
    });
  }
}

function getMessageAndStack(error) {
  const message = error.message || '<unknown error>'
  let messageAndStack = error.stack || message
  if (!messageAndStack.includes(message)) {
    messageAndStack = message + "\n" + messageAndStack;
  }

  return messageAndStack
}

// Rendezvous with the WebAssembly initializer. Either module may create the object first because
// library initializer module evaluation order is not guaranteed; the initializer resolves it.
function hotReloadAgentSignal() {
  const agent = globalThis.__DOTNET_WATCH_HOT_RELOAD_AGENT ||= {};
  if (!agent.ready) {
    agent.ready = new Promise(resolve => {
      agent.setReady = () => {
        agent.isReady = true;
        resolve();
      };
    });
  }

  return agent;
}

function hasDeltaApplyApi() {
  return !!(hotReloadAgentSignal().applyHotReloadDeltas || window.Blazor?._internal?.applyHotReloadDeltas || window.Blazor?._internal?.applyHotReload);
}

// The provider sends the replay snapshot once, so applying it before the agent installed the apply
// API would drop those updates while still reporting success. Wait for the agent to finish starting.
// Runtimes that install the apply API through their own bootstrap never publish the signal, so the
// wait is bounded and best effort.
async function waitForDeltaApplyApi() {
  if (hasDeltaApplyApi()) {
    return true;
  }

  try {
    await withTimeout(hotReloadAgentSignal().ready, hotReloadAgentReadyTimeoutMs);
  } catch (error) {
    console.debug('Timed out waiting for the Hot Reload agent.', error);
  }

  return hasDeltaApplyApi();
}

function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(`Timed out after ${milliseconds}ms.`), milliseconds);
    promise.then(
      value => { clearTimeout(timeout); resolve(value); },
      error => { clearTimeout(timeout); reject(error); });
  });
}

// Generates the secret this browser uses to authenticate the provider and encrypts it with the
// build-pinned public key. The secret itself never leaves the browser in clear text and is never
// persisted.
async function getSecret(serverKeyString) {
  if (!serverKeyString || !window.crypto || !window.crypto.subtle) {
    return null;
  }

  const secretBytes = window.crypto.getRandomValues(new Uint8Array(32)); // 32-bytes of entropy

  // Based on https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey#subjectpublickeyinfo_import
  const binaryServerKey = str2ab(atob(serverKeyString));
  const serverKey = await window.crypto.subtle.importKey('spki', binaryServerKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ['encrypt']);
  const encrypted = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, serverKey, secretBytes);
  return {
    encryptedSharedSecret: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    encodedSharedSecret: btoa(String.fromCharCode(...secretBytes)),
  };

  function str2ab(str) {
    const buf = new ArrayBuffer(str.length);
    const bufView = new Uint8Array(buf);
    for (let i = 0, strLen = str.length; i < strLen; i++) {
      bufView[i] = str.charCodeAt(i);
    }
    return buf;
  }
}

// SIG // Begin signature block
// SIG // MIInXQYJKoZIhvcNAQcCoIInTjCCJ0oCAQExDzANBglg
// SIG // hkgBZQMEAgEFADB3BgorBgEEAYI3AgEEoGkwZzAyBgor
// SIG // BgEEAYI3AgEeMCQCAQEEEBDgyQbOONQRoqMAEEvTUJAC
// SIG // AQACAQACAQACAQACAQAwMTANBglghkgBZQMEAgEFAAQg
// SIG // vQ8My3DGTW+HxgZiUNsmjuabqwfgPK+wZOeCuzFNWv2g
// SIG // ggy4MIIF8zCCA9ugAwIBAgITMwAAAceaoe7cJ+L4twAA
// SIG // AAABxzANBgkqhkiG9w0BAQsFADBXMQswCQYDVQQGEwJV
// SIG // UzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
// SIG // MSgwJgYDVQQDEx9NaWNyb3NvZnQgQ29kZSBTaWduaW5n
// SIG // IFBDQSAyMDI0MB4XDTI2MDQxNjE4NTczOVoXDTI3MDQx
// SIG // NTE4NTczOVowYzELMAkGA1UEBhMCVVMxEzARBgNVBAgT
// SIG // Cldhc2hpbmd0b24xEDAOBgNVBAcTB1JlZG1vbmQxHjAc
// SIG // BgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjENMAsG
// SIG // A1UEAxMELk5FVDCCASIwDQYJKoZIhvcNAQEBBQADggEP
// SIG // ADCCAQoCggEBAMB61gBm+zIpG+zndRVKQsKhMDkm93i+
// SIG // sXwp1OHJ+EGnqv1EntlMxQ3XglhWpxS83yMw+VBm/IAT
// SIG // tMIr2/2LITEnBBgY8+EA+SCxn1G0cBlR0WhlEvQs49DG
// SIG // k4iUoAbAyEDjThvokHS6apuvqwViuP+cFci9SS4x6a45
// SIG // h+ujrl5qy77RkgYpBhapvgPLM1zvtPsCzh1t7j2K/05r
// SIG // 4JJAJqWIPZ+PjSvXJLKW95EH3vxPhtfdhm6sEK4xpcKM
// SIG // CG7qsL/dCqhGeHk+IQgxTecwZyWbMyY305PiUnGcc728
// SIG // 8wHNr36J3Z8c5BWFWptyocQafTXjiMil7OS8KYmhgHYg
// SIG // 6xkCAwEAAaOCAaowggGmMA4GA1UdDwEB/wQEAwIHgDAf
// SIG // BgNVHSUEGDAWBgorBgEEAYI3TAgBBggrBgEFBQcDAzAd
// SIG // BgNVHQ4EFgQUgAm0ef/T6uytGybTjdg8DFX/L58wVAYD
// SIG // VR0RBE0wS6RJMEcxLTArBgNVBAsTJE1pY3Jvc29mdCBJ
// SIG // cmVsYW5kIE9wZXJhdGlvbnMgTGltaXRlZDEWMBQGA1UE
// SIG // BRMNNDY0MjIzKzUwNzYwNjAfBgNVHSMEGDAWgBR/WT9U
// SIG // IdqtT+8F5eaj1y0GlBIIMTBgBgNVHR8EWTBXMFWgU6BR
// SIG // hk9odHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3Bz
// SIG // L2NybC9NaWNyb3NvZnQlMjBDb2RlJTIwU2lnbmluZyUy
// SIG // MFBDQSUyMDIwMjQuY3JsMG0GCCsGAQUFBwEBBGEwXzBd
// SIG // BggrBgEFBQcwAoZRaHR0cDovL3d3dy5taWNyb3NvZnQu
// SIG // Y29tL3BraW9wcy9jZXJ0cy9NaWNyb3NvZnQlMjBDb2Rl
// SIG // JTIwU2lnbmluZyUyMFBDQSUyMDIwMjQuY3J0MAwGA1Ud
// SIG // EwEB/wQCMAAwDQYJKoZIhvcNAQELBQADggIBAImzEt/g
// SIG // Gt+QAA3NGlRZUv+koTULWxSFT/osH1YxbVKFgSYU9dA9
// SIG // BpFDzo1lF+IhVTgjjwHXhaA87P4YTztl3RQfrlrrED7F
// SIG // 008DHiJ+G/7nnTxkb7y9fNRTTw9Ac/hGTWkQBW5Vaujm
// SIG // gWQflToTpMKNlqVbGFg+UVZKxi+k5MhsULjKt5K/ulH5
// SIG // bVuvnXrZmeF3XRGuSsQe2YjpNYaYHq713itwdNwyYq7p
// SIG // rpQ4R3xiUBw6SOOaH2UyDdhyQisZl8V3wFNhY2t6yZkQ
// SIG // CyGG+GZF49Q8vc1l+Tl+pcRa8l+4u3Rq18QUDJenW4Up
// SIG // 5y/a+mLTyxM8pYRQpPDqVX5U9NTfLbgZWKxQmkN+0mpJ
// SIG // 4CRpAniIiJJC4ag7Wjky+Asgik8xb/16wqiw72xDdPCk
// SIG // 7TN0g/G4PlmyyDP+hdSjzlq5JiQK2ubfEhAqoRD1tmKK
// SIG // 4R3QqIFlLZsPjE87AXlZ4PJHzutH2YnNsUQ45oDDCf3j
// SIG // 6vfslGL01M3XAgkDXhskyOXxb1v7of0JR8GzCvsIkNeM
// SIG // QmeXc5FZwi7xXG6UeNh1Z4SA3qJo+H+ItV/dMgjxCWPl
// SIG // Yfzgh6a2CXXaEruZvnLpwD+cCuZxYhGYIJfrsWoCh4Gf
// SIG // AtkvG3Z0fHgeftB90byXroQbupqohCUppbug9df+2PjO
// SIG // aPWk0oPvu/4HzFaZMIIGvTCCBKWgAwIBAgITMwAAADk7
// SIG // tjcZvwYdZwAAAAAAOTANBgkqhkiG9w0BAQwFADCBiDEL
// SIG // MAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24x
// SIG // EDAOBgNVBAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1pY3Jv
// SIG // c29mdCBDb3Jwb3JhdGlvbjEyMDAGA1UEAxMpTWljcm9z
// SIG // b2Z0IFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIw
// SIG // MTEwHhcNMjQwODA4MjA1NDE4WhcNMzYwMzIyMjIxMzA0
// SIG // WjBXMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9z
// SIG // b2Z0IENvcnBvcmF0aW9uMSgwJgYDVQQDEx9NaWNyb3Nv
// SIG // ZnQgQ29kZSBTaWduaW5nIFBDQSAyMDI0MIICIjANBgkq
// SIG // hkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA2AGcHuM4x6qV
// SIG // Fgc1rbrm/ghj18fxMqF6Yd88g17WCktpXd2GDfbhbAfT
// SIG // otwdumewG6QIM2K2vKjR21L8Rboj/IQv9stJjyEqlt9C
// SIG // 5a6wE+v2prNhwPEJb+qeNvkmwjWzxs06DdtUBO9BUvi1
// SIG // x/TdpPJyzPxB4J0zSX/IdE5sn1CprMzWvpU8Q4nssv64
// SIG // QRvvfDpAK6Gzz1rW6/XN6s5gyeyd5FHAJunJbXUhyCBT
// SIG // RxEoMOrWmNUnMhsgXr6iJddtF46yB4jzO7UXJB8rR9WR
// SIG // rJrxKZUdD+05/beZnhb2TRGLbZBb2ndSBILk5QOS0rHF
// SIG // wKYYvq1ct84ZJYcghXhitMlNPo823LlESiMcm5kcCuQX
// SIG // 1WcdMRFahOMDN8jeQ/7lvhqVR2GABnu2067VtWdd8dqo
// SIG // 9iXas+zbSOLTcs5VayH+tp2ATXt6zmEv63qVXR5UetWG
// SIG // yyxE5Ym7PYxcwK3uLDuUU8b0tcoaOyaiefaCi0Z0ci4S
// SIG // DkmckwlWaLF3ktGWSaBhFkrOHFILDKgYirQ+FoDtj5U9
// SIG // y3mkIeSKNwggObSeWQr7QrJ6miVyoabRP8ZhBEyEcmUY
// SIG // 46ZVCinfrBRVRiSVTL768NZ4SASjizuHE3qYht/YxIhD
// SIG // +Ih8xmAnELr2i6QxRcKs4LdKQT/EiSCl+XbYwzWK2Rnf
// SIG // mc1eQyiVTWUCAwEAAaOCAU4wggFKMA4GA1UdDwEB/wQE
// SIG // AwIBhjAQBgkrBgEEAYI3FQEEAwIBADAdBgNVHQ4EFgQU
// SIG // f1k/VCHarU/vBeXmo9ctBpQSCDEwGQYJKwYBBAGCNxQC
// SIG // BAweCgBTAHUAYgBDAEEwDwYDVR0TAQH/BAUwAwEB/zAf
// SIG // BgNVHSMEGDAWgBRyLToCMZBDuRQFTuHqp8cx0SOJNDBa
// SIG // BgNVHR8EUzBRME+gTaBLhklodHRwOi8vY3JsLm1pY3Jv
// SIG // c29mdC5jb20vcGtpL2NybC9wcm9kdWN0cy9NaWNSb29D
// SIG // ZXJBdXQyMDExXzIwMTFfMDNfMjIuY3JsMF4GCCsGAQUF
// SIG // BwEBBFIwUDBOBggrBgEFBQcwAoZCaHR0cDovL3d3dy5t
// SIG // aWNyb3NvZnQuY29tL3BraS9jZXJ0cy9NaWNSb29DZXJB
// SIG // dXQyMDExXzIwMTFfMDNfMjIuY3J0MA0GCSqGSIb3DQEB
// SIG // DAUAA4ICAQAUlB84KE/uiefp8sgwqtKU3VZgrAMWAB13
// SIG // KY5Q7cWszx3sH9b+JDoPFewOfsPlbjAzBh4vKy1wSp+S
// SIG // PPg1RFGBrPIy7nJHNCHguqMDi1K1NwmHWikTGjuefk+4
// SIG // 8Fidu7T5MdK5UdN7RVNM9WGKXL+mIWsOjdrFD0/gL46X
// SIG // nJ637aBN96QgJLnFL5xh9Ii+CfQmSxUFUxhUjlAW7+qG
// SIG // cuGwQURTMbx++/SGOCQ76WSlX23LoaQ3i92d3vJrpDpp
// SIG // H3LfhqIzWqbFrEGLo5SfI2Xp+S66f92JMWdgMtOmk6Sv
// SIG // +aDlZJ8KINUw0LG2PjA8oLk6YebUNAi38w2iRtsfdQaw
// SIG // U/VBvOwuhy5KosK8fT0ijd8M9OaxxH1jvkbipftFNfwB
// SIG // 0E+jQjo4SiN/f3O4Vm3So4ebrlhZATr1xkza54TUwHTl
// SIG // 002Acr2BMTvMq8r9+DwHaqNbzwxP9YXlXm69ka2pr0VI
// SIG // vZFrMCsD6sM+5/okZjPgemAxkcHhLqzNZIpgG/RWKwLN
// SIG // /GB5T52q5db1t3Rq5iU4HnwM9w5gp1zdJ73iD7EvilwS
// SIG // FsHngk6ACTBhO7/10t4fakOp4lkAAFUNZFAJpd87kuDI
// SIG // rAoIthemKCtlgKNRIFyv5V7w8VYyFVNCXS/irwn8BSZA
// SIG // 3lbifXTVxjYvgDsZNAbWHfYccC99ARJY/TGCGf0wghn5
// SIG // AgEBMG4wVzELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1p
// SIG // Y3Jvc29mdCBDb3Jwb3JhdGlvbjEoMCYGA1UEAxMfTWlj
// SIG // cm9zb2Z0IENvZGUgU2lnbmluZyBQQ0EgMjAyNAITMwAA
// SIG // Aceaoe7cJ+L4twAAAAABxzANBglghkgBZQMEAgEFAKCB
// SIG // rjAZBgkqhkiG9w0BCQMxDAYKKwYBBAGCNwIBBDAcBgor
// SIG // BgEEAYI3AgELMQ4wDAYKKwYBBAGCNwIBFTAvBgkqhkiG
// SIG // 9w0BCQQxIgQg7o+7wbuizRyE40OwarCqVCcnFuDEjw0w
// SIG // B3Ts9vnYfk0wQgYKKwYBBAGCNwIBDDE0MDKgFIASAE0A
// SIG // aQBjAHIAbwBzAG8AZgB0oRqAGGh0dHA6Ly93d3cubWlj
// SIG // cm9zb2Z0LmNvbTANBgkqhkiG9w0BAQEFAASCAQBCsYqm
// SIG // 9a60/9yoBoj9D3WIeYWACpfkVIu5JWGut0rp2EUz96ww
// SIG // XcAXuMJlf7EOy2eqy8F0Tw/rXKtuI391xR6NdVzE1ugd
// SIG // ukmnoKRld6ll4qyyHsYHOaNmFqdDSWdyMOb38Z51aRpJ
// SIG // jo6wdR9v+s5E/sIvWd7T8HRqskiG7XcD8UQOjXgU0iJo
// SIG // Bz/vUxOJ1NG8qfT0PT48iqh2R6NMCbmt745AdsYS49mr
// SIG // 5FD/SfRX2YFN1Vjk4RiCeu2se0h5Ux7ND558S7k0G14r
// SIG // co3j3Q0pMys6UidecS1NW8Gz9umz3o2oOgGaGRhwNQAa
// SIG // hI0YV/knp0epZpGDOW1ppC41ABPjoYIXrzCCF6sGCisG
// SIG // AQQBgjcDAwExghebMIIXlwYJKoZIhvcNAQcCoIIXiDCC
// SIG // F4QCAQMxDzANBglghkgBZQMEAgEFADCCAVkGCyqGSIb3
// SIG // DQEJEAEEoIIBSASCAUQwggFAAgEBBgorBgEEAYRZCgMB
// SIG // MDEwDQYJYIZIAWUDBAIBBQAEIBzMD6Cs2qw3znJnOtR3
// SIG // sSkbrYZQeWKYrnaUYHAuVgSsAgZq3gC2li8YEjIwMjYx
// SIG // MDMwMDQyMTQ0LjE3WjAEgAIB9KCB2aSB1jCB0zELMAkG
// SIG // A1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAO
// SIG // BgNVBAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29m
// SIG // dCBDb3Jwb3JhdGlvbjEtMCsGA1UECxMkTWljcm9zb2Z0
// SIG // IElyZWxhbmQgT3BlcmF0aW9ucyBMaW1pdGVkMScwJQYD
// SIG // VQQLEx5uU2hpZWxkIFRTUyBFU046NjUxQS0wNUUwLUQ5
// SIG // NDcxJTAjBgNVBAMTHE1pY3Jvc29mdCBUaW1lLVN0YW1w
// SIG // IFNlcnZpY2WgghH+MIIHKDCCBRCgAwIBAgITMwAAAhUY
// SIG // A9OBByZ8UwABAAACFTANBgkqhkiG9w0BAQsFADB8MQsw
// SIG // CQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQ
// SIG // MA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9z
// SIG // b2Z0IENvcnBvcmF0aW9uMSYwJAYDVQQDEx1NaWNyb3Nv
// SIG // ZnQgVGltZS1TdGFtcCBQQ0EgMjAxMDAeFw0yNTA4MTQx
// SIG // ODQ4MjBaFw0yNjExMTMxODQ4MjBaMIHTMQswCQYDVQQG
// SIG // EwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UE
// SIG // BxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENv
// SIG // cnBvcmF0aW9uMS0wKwYDVQQLEyRNaWNyb3NvZnQgSXJl
// SIG // bGFuZCBPcGVyYXRpb25zIExpbWl0ZWQxJzAlBgNVBAsT
// SIG // Hm5TaGllbGQgVFNTIEVTTjo2NTFBLTA1RTAtRDk0NzEl
// SIG // MCMGA1UEAxMcTWljcm9zb2Z0IFRpbWUtU3RhbXAgU2Vy
// SIG // dmljZTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoC
// SIG // ggIBAMNx1d4VcS9JRGD1dN13jSmede1SG4HsYZQz3aV8
// SIG // A0tAWLcT8IuF2KWUdZXdLunK9l47roHYOdA1MeVhy9EI
// SIG // WNnfb5CUpNNqxP++YXCrfdZtiIdvO0EcUTJhbtwReuOu
// SIG // pPKqebl7X3urnIquPWGkvKfnc797k2qw+IUPFE+y2vea
// SIG // TiYkascXdKjhixArxyxFz14qDUsfacoc4Zupbe3sy8SX
// SIG // hVWLcUoZGrz6GTdHTgomHoeCoKCqMmoMzLkoiwojFFuF
// SIG // HuELJuufBSTRkzYe1eal2FQOpOcY8OVnlnSjs9IvQOYw
// SIG // XG2PX1TqP3APItW8rc3A08W953LXJcvPzmHjbLZGm/yL
// SIG // KtwsXtb6venyBxNfmRpiY5GtbKHcKj8nFaf9rW/gY7pT
// SIG // y+Q+q4FF0zxfOFPNkSyh1ee2wfHx0aYJ43FgULlz4FXk
// SIG // l6REVoprdDRdpQji86oK70v72KnXuS5/WJSioQGf8QxN
// SIG // EyyCK+viP9iU7Vz9+J340xDVajASElnGpCMQMBm90Qec
// SIG // hwscpyBTVS3HygLBHQuVNnptHwL5lb9LKJ6p79e3LmmI
// SIG // tngi1oaCtSHPOQ8O7P5YXF6waWOJ/0ZeZd8B87OLziIb
// SIG // vOwyMuUFGhLqRLMmNDVqoCOAVper9cILHvpfA1hXlF6H
// SIG // 4VLgoFU7kxzdyvInaDG5/EN3nVCBAgMBAAGjggFJMIIB
// SIG // RTAdBgNVHQ4EFgQUiSF38XKgMBaho/Y3cELXUqmnY9cw
// SIG // HwYDVR0jBBgwFoAUn6cVXQBeYl2D9OXSZacbUzUZ6XIw
// SIG // XwYDVR0fBFgwVjBUoFKgUIZOaHR0cDovL3d3dy5taWNy
// SIG // b3NvZnQuY29tL3BraW9wcy9jcmwvTWljcm9zb2Z0JTIw
// SIG // VGltZS1TdGFtcCUyMFBDQSUyMDIwMTAoMSkuY3JsMGwG
// SIG // CCsGAQUFBwEBBGAwXjBcBggrBgEFBQcwAoZQaHR0cDov
// SIG // L3d3dy5taWNyb3NvZnQuY29tL3BraW9wcy9jZXJ0cy9N
// SIG // aWNyb3NvZnQlMjBUaW1lLVN0YW1wJTIwUENBJTIwMjAx
// SIG // MCgxKS5jcnQwDAYDVR0TAQH/BAIwADAWBgNVHSUBAf8E
// SIG // DDAKBggrBgEFBQcDCDAOBgNVHQ8BAf8EBAMCB4AwDQYJ
// SIG // KoZIhvcNAQELBQADggIBAHeNh7VfpBm78cywUwuTu75A
// SIG // iAT8vwcKYws3i+d4QIhDnm6flXTZ8JvRlQn2KtyjH64+
// SIG // FLykE1AGkuWZMHtYL2d5Y0kpwjskuTsDbvXaYN8MPkFt
// SIG // njnEi5MlQFhay5+iIoN0wv81jL1Yal7XRYRtiidZUmzd
// SIG // ttnLGNxN/waxpbgJbxE/YJsVcssTcuff+yRecyBnCYm8
// SIG // ncbPeCS9QbT4FyTn2c0Pv94k3Ong7Zmlk+gynZyaHKfM
// SIG // JFyljyLARH5A+pNUIrcL7dJh6zkWoe+Uo3nDireKFmsl
// SIG // S5D04aNdntKJ4BINXI3uX8UmRrYazK1iryOEexxAu5PJ
// SIG // mh/XjwN1Yh9AlUkjnn2j0xjMyIRwqOad4xuUjHMjt3gP
// SIG // bhGmECSEyZSxtwcMBpsqWOwv/P549UjoYMdR4CdMsDiS
// SIG // /cXz+ADnFpgn27KoBmwmgu1h+bCDXc3zGq/Fe2DRapGw
// SIG // hlCoXPBqSMhPjCp8lZ9947LmhgJTUYO3VUVEqGCycb1L
// SIG // MPRjsMgaQcGxPbKji5vh7DtNKBdtzzIqO1hV3BU2QI6d
// SIG // 7o4oQQHy61yAoBjhz3ZGdONrtS2ajnJ5a91874DHvpjz
// SIG // 8mrFvH9K7cyY91eRPxCoskJT8Y/TH6tsfYYpp5V1hmQl
// SIG // T3hAUTqzWw2AX2s08izQjk7EbZLDkldxQbT56ULSze+e
// SIG // MIIHcTCCBVmgAwIBAgITMwAAABXF52ueAptJmQAAAAAA
// SIG // FTANBgkqhkiG9w0BAQsFADCBiDELMAkGA1UEBhMCVVMx
// SIG // EzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1Jl
// SIG // ZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3Jh
// SIG // dGlvbjEyMDAGA1UEAxMpTWljcm9zb2Z0IFJvb3QgQ2Vy
// SIG // dGlmaWNhdGUgQXV0aG9yaXR5IDIwMTAwHhcNMjEwOTMw
// SIG // MTgyMjI1WhcNMzAwOTMwMTgzMjI1WjB8MQswCQYDVQQG
// SIG // EwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UE
// SIG // BxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENv
// SIG // cnBvcmF0aW9uMSYwJAYDVQQDEx1NaWNyb3NvZnQgVGlt
// SIG // ZS1TdGFtcCBQQ0EgMjAxMDCCAiIwDQYJKoZIhvcNAQEB
// SIG // BQADggIPADCCAgoCggIBAOThpkzntHIhC3miy9ckeb0O
// SIG // 1YLT/e6cBwfSqWxOdcjKNVf2AX9sSuDivbk+F2Az/1xP
// SIG // x2b3lVNxWuJ+Slr+uDZnhUYjDLWNE893MsAQGOhgfWpS
// SIG // g0S3po5GawcU88V29YZQ3MFEyHFcUTE3oAo4bo3t1w/Y
// SIG // JlN8OWECesSq/XJprx2rrPY2vjUmZNqYO7oaezOtgFt+
// SIG // jBAcnVL+tuhiJdxqD89d9P6OU8/W7IVWTe/dvI2k45GP
// SIG // sjksUZzpcGkNyjYtcI4xyDUoveO0hyTD4MmPfrVUj9z6
// SIG // BVWYbWg7mka97aSueik3rMvrg0XnRm7KMtXAhjBcTyzi
// SIG // YrLNueKNiOSWrAFKu75xqRdbZ2De+JKRHh09/SDPc31B
// SIG // mkZ1zcRfNN0Sidb9pSB9fvzZnkXftnIv231fgLrbqn42
// SIG // 7DZM9ituqBJR6L8FA6PRc6ZNN3SUHDSCD/AQ8rdHGO2n
// SIG // 6Jl8P0zbr17C89XYcz1DTsEzOUyOArxCaC4Q6oRRRuLR
// SIG // vWoYWmEBc8pnol7XKHYC4jMYctenIPDC+hIK12NvDMk2
// SIG // ZItboKaDIV1fMHSRlJTYuVD5C4lh8zYGNRiER9vcG9H9
// SIG // stQcxWv2XFJRXRLbJbqvUAV6bMURHXLvjflSxIUXk8A8
// SIG // FdsaN8cIFRg/eKtFtvUeh17aj54WcmnGrnu3tz5q4i6t
// SIG // AgMBAAGjggHdMIIB2TASBgkrBgEEAYI3FQEEBQIDAQAB
// SIG // MCMGCSsGAQQBgjcVAgQWBBQqp1L+ZMSavoKRPEY1Kc8Q
// SIG // /y8E7jAdBgNVHQ4EFgQUn6cVXQBeYl2D9OXSZacbUzUZ
// SIG // 6XIwXAYDVR0gBFUwUzBRBgwrBgEEAYI3TIN9AQEwQTA/
// SIG // BggrBgEFBQcCARYzaHR0cDovL3d3dy5taWNyb3NvZnQu
// SIG // Y29tL3BraW9wcy9Eb2NzL1JlcG9zaXRvcnkuaHRtMBMG
// SIG // A1UdJQQMMAoGCCsGAQUFBwMIMBkGCSsGAQQBgjcUAgQM
// SIG // HgoAUwB1AGIAQwBBMAsGA1UdDwQEAwIBhjAPBgNVHRMB
// SIG // Af8EBTADAQH/MB8GA1UdIwQYMBaAFNX2VsuP6KJcYmjR
// SIG // PZSQW9fOmhjEMFYGA1UdHwRPME0wS6BJoEeGRWh0dHA6
// SIG // Ly9jcmwubWljcm9zb2Z0LmNvbS9wa2kvY3JsL3Byb2R1
// SIG // Y3RzL01pY1Jvb0NlckF1dF8yMDEwLTA2LTIzLmNybDBa
// SIG // BggrBgEFBQcBAQROMEwwSgYIKwYBBQUHMAKGPmh0dHA6
// SIG // Ly93d3cubWljcm9zb2Z0LmNvbS9wa2kvY2VydHMvTWlj
// SIG // Um9vQ2VyQXV0XzIwMTAtMDYtMjMuY3J0MA0GCSqGSIb3
// SIG // DQEBCwUAA4ICAQCdVX38Kq3hLB9nATEkW+Geckv8qW/q
// SIG // XBS2Pk5HZHixBpOXPTEztTnXwnE2P9pkbHzQdTltuw8x
// SIG // 5MKP+2zRoZQYIu7pZmc6U03dmLq2HnjYNi6cqYJWAAOw
// SIG // Bb6J6Gngugnue99qb74py27YP0h1AdkY3m2CDPVtI1Tk
// SIG // eFN1JFe53Z/zjj3G82jfZfakVqr3lbYoVSfQJL1AoL8Z
// SIG // thISEV09J+BAljis9/kpicO8F7BUhUKz/AyeixmJ5/AL
// SIG // aoHCgRlCGVJ1ijbCHcNhcy4sa3tuPywJeBTpkbKpW99J
// SIG // o3QMvOyRgNI95ko+ZjtPu4b6MhrZlvSP9pEB9s7GdP32
// SIG // THJvEKt1MMU0sHrYUP4KWN1APMdUbZ1jdEgssU5HLcEU
// SIG // BHG/ZPkkvnNtyo4JvbMBV0lUZNlz138eW0QBjloZkWsN
// SIG // n6Qo3GcZKCS6OEuabvshVGtqRRFHqfG3rsjoiV5PndLQ
// SIG // THa1V1QJsWkBRH58oWFsc/4Ku+xBZj1p/cvBQUl+fpO+
// SIG // y/g75LcVv7TOPqUxUYS8vwLBgqJ7Fx0ViY1w/ue10Cga
// SIG // iQuPNtq6TPmb/wrpNPgkNWcr4A245oyZ1uEi6vAnQj0l
// SIG // lOZ0dFtq0Z4+7X6gMTN9vMvpe784cETRkPHIqzqKOghi
// SIG // f9lwY1NNje6CbaUFEMFxBmoQtB1VM1izoXBm8qGCA1kw
// SIG // ggJBAgEBMIIBAaGB2aSB1jCB0zELMAkGA1UEBhMCVVMx
// SIG // EzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1Jl
// SIG // ZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3Jh
// SIG // dGlvbjEtMCsGA1UECxMkTWljcm9zb2Z0IElyZWxhbmQg
// SIG // T3BlcmF0aW9ucyBMaW1pdGVkMScwJQYDVQQLEx5uU2hp
// SIG // ZWxkIFRTUyBFU046NjUxQS0wNUUwLUQ5NDcxJTAjBgNV
// SIG // BAMTHE1pY3Jvc29mdCBUaW1lLVN0YW1wIFNlcnZpY2Wi
// SIG // IwoBATAHBgUrDgMCGgMVAI+nk3o27mBNSH42367erV3r
// SIG // wlEgoIGDMIGApH4wfDELMAkGA1UEBhMCVVMxEzARBgNV
// SIG // BAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1JlZG1vbmQx
// SIG // HjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEm
// SIG // MCQGA1UEAxMdTWljcm9zb2Z0IFRpbWUtU3RhbXAgUENB
// SIG // IDIwMTAwDQYJKoZIhvcNAQELBQACBQDujm1gMCIYDzIw
// SIG // MjYxMDMwMDExMjAwWhgPMjAyNjEwMzEwMTEyMDBaMHcw
// SIG // PQYKKwYBBAGEWQoEATEvMC0wCgIFAO6ObWACAQAwCgIB
// SIG // AAICJBACAf8wBwIBAAICEzwwCgIFAO6PvuACAQAwNgYK
// SIG // KwYBBAGEWQoEAjEoMCYwDAYKKwYBBAGEWQoDAqAKMAgC
// SIG // AQACAwehIKEKMAgCAQACAwGGoDANBgkqhkiG9w0BAQsF
// SIG // AAOCAQEABls+4KOUlShkn28kc0EQvyxbOScIZm8t2nEO
// SIG // pxGd7ndlapedDAWYmmAkpYmv29y8rZ2TCwlw58yABtP+
// SIG // IY5XH/Y+K+bT25izyukM6W/Vq/hwDSMAs+S7iw4TkGFu
// SIG // dl/rV9p/N61888MW11n52EJ280pZ1NHndoVLJ2tvqe5y
// SIG // s5Rp/tr8uSBw/PrdSz30a14KoH8dELQEaIIaAq3dzfer
// SIG // g8UTSNMq+YKdfchJWQW+iuM0vaMorNaLiRaZmAp6K2mg
// SIG // wMgccWmK3rCD58F6a9UMIXG89BujbYwm3CH7QpRIMRdK
// SIG // BQW1Q2TtLED6UpkBnflivAThWS+BgrGeyiUdhI6IRDGC
// SIG // BA0wggQJAgEBMIGTMHwxCzAJBgNVBAYTAlVTMRMwEQYD
// SIG // VQQIEwpXYXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25k
// SIG // MR4wHAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24x
// SIG // JjAkBgNVBAMTHU1pY3Jvc29mdCBUaW1lLVN0YW1wIFBD
// SIG // QSAyMDEwAhMzAAACFRgD04EHJnxTAAEAAAIVMA0GCWCG
// SIG // SAFlAwQCAQUAoIIBSjAaBgkqhkiG9w0BCQMxDQYLKoZI
// SIG // hvcNAQkQAQQwLwYJKoZIhvcNAQkEMSIEIPgSi3OUQ1A7
// SIG // DL6ayqsFAGCZ9lhc/QXvfInYiT2KAX3UMIH6BgsqhkiG
// SIG // 9w0BCRACLzGB6jCB5zCB5DCBvQQgcBD0djw60xS3K7UL
// SIG // Cq1Iu6M+STUQhfykRzIoUjXu7IowgZgwgYCkfjB8MQsw
// SIG // CQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQ
// SIG // MA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9z
// SIG // b2Z0IENvcnBvcmF0aW9uMSYwJAYDVQQDEx1NaWNyb3Nv
// SIG // ZnQgVGltZS1TdGFtcCBQQ0EgMjAxMAITMwAAAhUYA9OB
// SIG // ByZ8UwABAAACFTAiBCCV7rXr+bTLxaQf6970nLZvaOYv
// SIG // qmk5H0rImPGdSUGSyzANBgkqhkiG9w0BAQsFAASCAgA/
// SIG // m2X/9pJ46Z9MFS5g+LrMIyh5Z1b/exwFHCUSLc9o9q3h
// SIG // /1PyJxtyGbFescXXy6ACY6YvrYit1JJ/aX0RsoLM3vZ0
// SIG // RWaGTtT2UvZixUOyik5dE6ZpNIdZxHdEyw1BX8K47Sg3
// SIG // MGUGddeuft24RxLh3f5t70iuKW0e1hz5SeKghV32yimf
// SIG // LylRlgdSpBcmOspqJIW2MjQXjM5xbQmGTiu6DPlioy7y
// SIG // 91ev9elW2QkOsaWP0r9d2s2pTNO6sx3x6p/YLPDusDpt
// SIG // JvnT8oAG/B3kb8xMun/348mFbWSZcg2JeTg2eFq6Q02F
// SIG // dDOOxRrspts1P3/qebP4kvhk8Wm+OEzwRO20hUD9MGZB
// SIG // z4zRRfnrohO6Caj9sf8jGvqa6zvsJ23+0obvamwoRFW6
// SIG // UOA+J4v9mJBO+Xh6lTyhbQr5/0oXJuTtVah+UPWB3t6J
// SIG // 3WrLNpuZ4G3W8IgF5Si4fTJ/YpKByTOJc3pmqhOzNkCL
// SIG // 3PKRy4iUOUy+52BNFXaCm8+GyBISsvWwlfV5rsMQ0Lx9
// SIG // BE4TY49XaZ9Vdc25PWiNx77nqCShwH0G/eWIJDK1PcVF
// SIG // GSo4lxb1ReUl3Oa4JyKLnMtu6eXygcpv5Rq2gzikMUJo
// SIG // 9QmO0qMgs8hFIpjxfwgcEKcHr9A7+pA1UuvIrCPpmhxX
// SIG // EWpcWib0wrPRfWCopVBlsw==
// SIG // End signature block
