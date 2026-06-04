# HTTP Request Headers Documentation

## Overview

This documentation describes the HTTP request headers used in video streaming requests to `data.nsfwph.org`. The requests are HTTP/2 GET requests for MP4 video files with byte range support.

## Common Headers (All Requests)

These headers remain **constant** across all video requests from the same client session:

| Header               | Value                                                                   | Description                                                                                     |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `:authority`         | `data.nsfwph.org`                                                       | HTTP/2 pseudo-header specifying the target host                                                 |
| `:method`            | `GET`                                                                   | HTTP method for retrieving the resource                                                         |
| `:scheme`            | `https`                                                                 | Protocol scheme (TLS encrypted)                                                                 |
| `accept`             | `*/*`                                                                   | Accept any MIME type in response                                                                |
| `accept-encoding`    | `identity;q=1, *;q=0`                                                   | No compression; prefers identity encoding only                                                  |
| `accept-language`    | `en-US,en;q=0.9,zh-CN;q=0.8,zh-TW;q=0.7,zh;q=0.6`                       | Language preferences (English primary, Chinese variants secondary)                              |
| `cache-control`      | `no-cache`                                                              | Bypass cached responses; force revalidation                                                     |
| `pragma`             | `no-cache`                                                              | Legacy HTTP/1.1 cache directive (backward compatibility)                                        |
| `priority`           | `i`                                                                     | Request priority level (`i` = lowest priority, typically for background/non-critical resources) |
| `referer`            | `https://nsfwph.org/`                                                   | Originating page URL                                                                            |
| `sec-ch-ua`          | `"Opera";v="131", "Not.A/Brand";v="8", "Chromium";v="147"`              | Client hints: browser branding and version                                                      |
| `sec-ch-ua-mobile`   | `?0`                                                                    | Client hints: indicates desktop device (not mobile)                                             |
| `sec-ch-ua-platform` | `"macOS"`                                                               | Client hints: operating system platform                                                         |
| `sec-fetch-dest`     | `video`                                                                 | Fetch destination type (video resource)                                                         |
| `sec-fetch-mode`     | `no-cors`                                                               | CORS mode (no cross-origin restrictions needed)                                                 |
| `sec-fetch-site`     | `same-site`                                                             | Same-site request (same eTLD+1 as referer)                                                      |
| `user-agent`         | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36...` | Browser identification string                                                                   |

## Variable Headers

These headers **change** per request:

| Header  | Example Values                                                               | Description                                                                                                     |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `:path` | `/video/13590/13590689-74729c5af3a4cafe850880e39a764af2.mp4?hash=JRP7nOEBwX` | HTTP/2 pseudo-header: request path including query string. Contains video ID, filename, and authentication hash |
| `range` | `bytes=0-` (initial request) <br> `bytes=163840-` (resume request)           | Byte range request. `0-` = entire file; `163840-` = from byte 163840 to end                                     |

## Path Structure

```
/video/{category_id}/{filename}.mp4?hash={token}
```

| Component        | Example                                         | Description                                              |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `category_id`    | `13590`                                         | Video category/folder identifier                         |
| `filename`       | `13590689-74729c5af3a4cafe850880e39a764af2.mp4` | Unique video filename with MD5-like hash                 |
| `hash` parameter | `JRP7nOEBwX`                                    | Authentication/access token (required, server validates) |

## Byte Range Usage

The `range` header enables **partial content delivery** (HTTP 206 responses):

- **Initial request**: `bytes=0-` — requests complete file from start
- **Resume request**: `bytes=163840-` — resumes download from specific byte offset
- **Custom range**: `bytes=start-end` — request specific byte range (e.g., `bytes=0-1048575` for first 1MB)

## Response Expectations

Based on observed responses:

- **Status**: `206 Partial Content` (when `range` header present)
- **Content-Type**: `video/mp4`
- **Cache-Control**: `max-age=31536000` (1 year cache)
- **Server**: Cloudflare with CDN caching

## Notes

1. **No cookies** are sent with these requests
2. **No request body** — all GET requests have `bodySize: 0`
3. **HTTP/2** is used exclusively (`http/2.0`)
4. The `hash` query parameter appears to be **required** for authorization
5. All requests are **same-site** (from `nsfwph.org` to `data.nsfwph.org`)

## Example Usage

### Initial full file request:

```
GET /video/13590/13590689-74729c5af3a4cafe850880e39a764af2.mp4?hash=JRP7nOEBwX HTTP/2.0
Host: data.nsfwph.org
Range: bytes=0-
Accept: */*
User-Agent: [client string]
```

### Resume partial download:

```
GET /video/13590/13590694-2181590f6a8feed9b42e2cc985c5de25.mp4?hash=UjwZ2iUhPU HTTP/2.0
Host: data.nsfwph.org
Range: bytes=163840-
Accept: */*
User-Agent: [client string]
```
