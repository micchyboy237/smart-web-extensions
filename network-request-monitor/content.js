// content.js - Enhanced with better logging and error handling
class NetworkInterceptor {
  constructor() {
    this.enabled = true;
    this.requestLog = [];
    console.log(
      "[Content] Network interceptor initialized at",
      window.location.href,
    );
    this.interceptFetch();
    this.interceptXHR();
    this.logPageInfo();
  }

  logPageInfo() {
    console.log("[Content] Page Info:", {
      url: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });
  }

  interceptFetch() {
    const originalFetch = window.fetch;
    const self = this;

    window.fetch = async function (...args) {
      const requestUrl = args[0];
      const requestOptions = args[1] || {};

      console.log(`[Content][Fetch] Intercepted request to:`, requestUrl);
      console.log(`[Content][Fetch] Method:`, requestOptions.method || "GET");

      try {
        const response = await originalFetch.apply(this, args);

        // Clone response to read body
        const clone = response.clone();

        // Try to read response body
        const contentType = response.headers.get("content-type");
        let bodyPromise;

        if (contentType && contentType.includes("application/json")) {
          bodyPromise = clone
            .json()
            .then((data) => JSON.stringify(data, null, 2));
        } else {
          bodyPromise = clone.text();
        }

        bodyPromise
          .then((body) => {
            console.log(`[Content][Fetch] Response from ${requestUrl}`);
            console.log(
              `[Content][Fetch] Status: ${response.status} ${response.statusText}`,
            );
            console.log(`[Content][Fetch] Content-Type: ${contentType}`);
            console.log(`[Content][Fetch] Body:`, body.substring(0, 500)); // Limit log size

            // Send to background
            chrome.runtime
              .sendMessage({
                type: "FETCH_RESPONSE",
                url: requestUrl,
                body: body,
                status: response.status,
                timestamp: new Date().toISOString(),
              })
              .catch((err) =>
                console.warn("[Content] Failed to send to background:", err),
              );
          })
          .catch((err) => {
            console.warn(
              "[Content][Fetch] Could not parse response body:",
              err,
            );
          });

        return response;
      } catch (error) {
        console.error("[Content][Fetch] Request failed:", error);
        throw error;
      }
    };

    console.log("[Content] Fetch API intercepted");
  }

  interceptXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const self = this;

    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      this._method = method;
      this._url = url;
      this._requestHeaders = {};

      console.log(`[Content][XHR] Open request: ${method} ${url}`);

      return originalOpen.apply(this, [method, url, ...args]);
    };

    // Intercept setRequestHeader to capture headers
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      this._requestHeaders[header] = value;
      console.log(`[Content][XHR] Header set: ${header}: ${value}`);
      return originalSetRequestHeader.apply(this, [header, value]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      console.log(`[Content][XHR] Sending request to:`, this._url);
      console.log(`[Content][XHR] Request body:`, args[0]);

      this.addEventListener("load", function () {
        console.log(`[Content][XHR] Response received from ${this._url}`);
        console.log(`[Content][XHR] Status: ${this.status} ${this.statusText}`);
        console.log(
          `[Content][XHR] Response headers:`,
          this.getAllResponseHeaders(),
        );
        console.log(
          `[Content][XHR] Response body preview:`,
          this.responseText?.substring(0, 500),
        );

        chrome.runtime
          .sendMessage({
            type: "XHR_RESPONSE",
            url: this._url,
            body: this.responseText,
            status: this.status,
            method: this._method,
            timestamp: new Date().toISOString(),
          })
          .catch((err) =>
            console.warn("[Content] Failed to send to background:", err),
          );
      });

      this.addEventListener("error", function () {
        console.error(`[Content][XHR] Request failed for ${this._url}`);
      });

      return originalSend.apply(this, args);
    };

    console.log("[Content] XHR intercepted");
  }
}

// Initialize interceptor
if (typeof window !== "undefined") {
  const interceptor = new NetworkInterceptor();

  // Log that content script is alive
  console.log("[Content] Network interceptor active on:", window.location.href);
}
