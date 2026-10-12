// Every number and address Waybill uses, in one place. Used by the extension
// and the server alike, so nothing here may touch chrome.* or node:*.
export const CONFIG = {
  // The local Waybill server. A VPS later only changes these two lines.
  serverPort: 4417,
  serverOrigin: 'http://127.0.0.1:4417',

  // The extension ID, pinned by the manifest key. The server accepts only it.
  extensionId: 'dmhkjckieepnigmelmogkmomgmkgkkdn',

  // Server connection.
  reconnectEveryMinutes: 1, // Chrome runs alarms at most every 30 s
  serverReachableTimeoutMs: 1_500,
  keepAliveEveryMs: 20_000, // the background is stopped after ~30 s without activity
  answerTimeoutMs: 120_000, // the longest any chain may wait for another place

  // Noticing marketplace sign-ins while the user browses.
  checkDelayMs: 1_500, // wait after a page load before checking the account
  recheckAfterMs: 5 * 60_000, // ordinary page loads re-check at most this often

  // The hidden page and its frames.
  hiddenPageIdleMs: 60_000, // closed after this long without work
  framePageTimeoutMs: 60_000, // loading (≤ 30 s) plus the site's rendering (≤ 20 s)
  maxOrderPages: 5,
};
