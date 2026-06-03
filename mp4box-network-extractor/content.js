// content.js - Injects MP4Box functionality into the page

console.log("[MP4Box Extractor] Content script loaded");

// Store MP4Box instances and data
const mp4BoxInstances = new Map();
const extractedData = new Map();

// Function to fetch and parse MP4 with MP4Box
async function parseMP4WithMP4Box(url, requestId) {
  console.log(`[MP4Box Extractor] Starting MP4Box parsing for: ${url}`);

  return new Promise((resolve, reject) => {
    try {
      // Create MP4Box file instance
      const mp4boxfile = MP4Box.createFile();
      let currentOffset = 0;
      let chunks = [];

      console.log(
        `[MP4Box Extractor] MP4Box instance created for request ${requestId}`,
      );

      // Set up event handlers
      mp4boxfile.onReady = (info) => {
        console.log(`[MP4Box Extractor] MP4Box onReady triggered for ${url}`);
        console.log(`[MP4Box Extractor] File info:`, info);

        const extractedInfo = {
          url: url,
          requestId: requestId,
          duration: info.duration,
          durationSec: info.duration / info.timescale,
          timescale: info.timescale,
          isFragmented: info.isFragmented,
          isProgressive: info.isProgressive,
          hasMoov: info.hasMoov,
          hasMdat: info.hasMdat,
          brands: info.brands,
          created: info.created,
          modified: info.modified,
          tracks: [],
          videoTracks: [],
          audioTracks: [],
          metadata: {},
        };

        // Process tracks
        if (info.tracks && info.tracks.length > 0) {
          console.log(`[MP4Box Extractor] Found ${info.tracks.length} tracks`);

          info.tracks.forEach((track, index) => {
            const trackInfo = {
              id: track.id,
              type: track.type,
              codec: track.codec,
              bitrate: track.bitrate,
              duration: track.duration,
              timescale: track.timescale,
              language: track.language,
              created: track.created,
              modified: track.modified,
              volume: track.volume,
              width: track.video ? track.video.width : null,
              height: track.video ? track.video.height : null,
              sampleRate: track.audio ? track.audio.sampleRate : null,
              channelCount: track.audio ? track.audio.channelCount : null,
              sampleSize: track.audio ? track.audio.sampleSize : null,
            };

            extractedInfo.tracks.push(trackInfo);

            if (track.type === "video") {
              extractedInfo.videoTracks.push(trackInfo);
              console.log(
                `[MP4Box Extractor] Video track ${track.id}: ${track.video.width}x${track.video.height}, codec: ${track.codec}`,
              );
            } else if (track.type === "audio") {
              extractedInfo.audioTracks.push(trackInfo);
              console.log(
                `[MP4Box Extractor] Audio track ${track.id}: ${track.audio.channelCount} channels, ${track.audio.sampleRate}Hz`,
              );
            }
          });
        }

        // Get sample info for first video track if available
        if (extractedInfo.videoTracks.length > 0) {
          const videoTrack = extractedInfo.videoTracks[0];
          const samples = mp4boxfile.getTrackSamples(videoTrack.id);
          if (samples && samples.length > 0) {
            extractedInfo.sampleInfo = {
              totalSamples: samples.length,
              firstSample: samples[0],
              lastSample: samples[samples.length - 1],
            };
            console.log(
              `[MP4Box Extractor] Sample info: ${samples.length} samples total`,
            );
          }
        }

        extractedData.set(requestId, extractedInfo);

        // Send to background script
        chrome.runtime
          .sendMessage({
            type: "MP4BOX_EXTRACTED",
            data: extractedInfo,
          })
          .catch(() => {});

        resolve(extractedInfo);
      };

      mp4boxfile.onError = (e) => {
        console.error(`[MP4Box Extractor] MP4Box error for ${url}:`, e);
        reject(e);
      };

      mp4boxfile.onMoovStart = () => {
        console.log(
          `[MP4Box Extractor] MP4Box moov parsing started for ${url}`,
        );
      };

      mp4boxfile.onMoovEnd = () => {
        console.log(
          `[MP4Box Extractor] MP4Box moov parsing completed for ${url}`,
        );
      };

      // Fetch the MP4 file
      console.log(`[MP4Box Extractor] Fetching MP4: ${url}`);
      fetch(url, {
        headers: {
          Range: "bytes=0-",
        },
      })
        .then((response) => {
          console.log(
            `[MP4Box Extractor] Fetch response status: ${response.status}`,
          );

          const reader = response.body.getReader();

          function readChunk() {
            reader
              .read()
              .then(({ done, value }) => {
                if (done) {
                  console.log(
                    `[MP4Box Extractor] Finished reading ${url}, flushing MP4Box`,
                  );
                  mp4boxfile.flush();
                  return;
                }

                console.log(
                  `[MP4Box Extractor] Read chunk of ${value.byteLength} bytes from ${url}`,
                );

                // Convert Uint8Array to ArrayBuffer
                const buffer = value.buffer;
                buffer.fileStart = currentOffset;

                // Append to MP4Box
                mp4boxfile.appendBuffer(buffer);
                currentOffset += value.byteLength;

                readChunk();
              })
              .catch(reject);
          }

          readChunk();
        })
        .catch(reject);
    } catch (error) {
      console.error(
        `[MP4Box Extractor] Error creating MP4Box instance:`,
        error,
      );
      reject(error);
    }
  });
}

// Listen for network requests from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PARSE_MP4") {
    console.log(
      `[MP4Box Extractor] Received parse request for: ${message.url}`,
    );
    parseMP4WithMP4Box(message.url, message.requestId)
      .then((data) => {
        sendResponse({ success: true, data: data });
      })
      .catch((error) => {
        console.error(`[MP4Box Extractor] Parse failed:`, error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === "GET_EXTRACTED_DATA") {
    const data = Array.from(extractedData.values());
    sendResponse({ data: data });
    return true;
  }
});

// Notify that content script is ready
console.log(
  "[MP4Box Extractor] Content script fully initialized and ready to parse MP4 files",
);
