//! On-disk store of played audio. Port of `lib/core/audio/audio_cache.dart`.
//!
//! A track heard once starts instantly the next time instead of re-resolving
//! and re-streaming it. Three shapes are handled:
//!
//! * the progressive transcoding, a single `.mp3` body;
//! * the AAC 160k stream, fragmented MP4 over HLS - its `EXT-X-MAP` init
//!   segment plus every media segment, concatenated in playlist order, is a
//!   valid `.m4a`;
//! * the encrypted HLS stream behind PlayReady, which cannot be concatenated
//!   because the CDM is driven from the playlist - so it is kept as a folder
//!   of segments beside a rewritten manifest. See [`AudioCache::store_drm`].
//!
//! The Flutter build could not use the `just_audio` caching source: it never
//! closed its write sink, and Windows refuses to rename a file with an open
//! handle, so the `.part` could never be finalised. That constraint is gone
//! here, but the deliberate second fetch is kept - it lets playback start from
//! the network immediately while the cache fills behind it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub const DEFAULT_MAX_BYTES: u64 = 512 * 1024 * 1024;
const DIR_NAME: &str = "audio_cache";

/// Extensions we may have written, newest format first. Real extensions are
/// kept so the player picks the right demuxer without sniffing.
const EXTENSIONS: [&str; 2] = ["m4a", "mp3"];

/// Encrypted streams live one folder per track under here.
const DRM_DIR: &str = "drm";
const DRM_MANIFEST: &str = "index.m3u8";

/// Stands in for a cached segment inside a stored manifest. The frontend
/// swaps each one for an asset-protocol URL, which only it can spell - see
/// `localiseManifest` in `src/audio/drmEngine.ts`. On disk the placeholder
/// carries the file name; [`AudioCache::hit_drm`] turns that into an index
/// into [`CachedDrmStream::files`].
const LOCAL_SCHEME: &str = "wf-local:";

static MAP_URI: Lazy<Regex> = Lazy::new(|| Regex::new(r#"URI="([^"]+)""#).unwrap());
static BYTERANGE_ATTR: Lazy<Regex> = Lazy::new(|| Regex::new(r#"BYTERANGE="([^"]+)""#).unwrap());
static LOCAL_REF: Lazy<Regex> = Lazy::new(|| Regex::new(r"wf-local:([A-Za-z0-9_.-]+)").unwrap());
static UNSAFE_CHARS: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^A-Za-z0-9_-]").unwrap());

/// A cached encrypted stream, ready to hand to Shaka once the placeholders are
/// resolved. The bytes stay encrypted exactly as the CDN served them, so
/// playback still needs a licence from SoundCloud on every play.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedDrmStream {
    /// HLS text whose media URIs are `wf-local:<n>` placeholders.
    pub manifest: String,
    /// The absolute path each placeholder index stands for.
    pub files: Vec<String>,
}

pub struct AudioCache {
    http: reqwest::Client,
    dir: PathBuf,
    pub max_bytes: u64,
    /// Track ids currently downloading, so a re-play mid-download does not
    /// start a second writer against the same `.part`. Encrypted downloads are
    /// keyed `drm:<id>`, since they are a separate copy of the track.
    inflight: Arc<Mutex<HashSet<String>>>,
}

impl AudioCache {
    pub fn new(http: reqwest::Client, base: impl AsRef<Path>, max_bytes: u64) -> Self {
        Self {
            http,
            dir: base.as_ref().join(DIR_NAME),
            max_bytes,
            inflight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    #[allow(dead_code)] // exposed for diagnostics and tests
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    async fn ensure_dir(&self) -> Result<()> {
        tokio::fs::create_dir_all(&self.dir)
            .await
            .with_context(|| format!("creating {}", self.dir.display()))
    }

    /// A cache key may only differ per track, never per resolved URL - those
    /// carry an expiring session id and would never hit twice.
    pub fn file_for(&self, track_id: &str, ext: &str) -> PathBuf {
        self.dir.join(format!("{}.{ext}", sanitise(track_id)))
    }

    fn drm_dir(&self, track_id: &str) -> PathBuf {
        self.dir.join(DRM_DIR).join(sanitise(track_id))
    }

    /// The finished file for `track_id`, or `None` if it is not cached yet.
    /// Only completed downloads are ever renamed into place, so existence
    /// means whole and playable.
    pub async fn hit(&self, track_id: &str) -> Option<PathBuf> {
        for ext in EXTENSIONS {
            let f = self.file_for(track_id, ext);
            if let Ok(meta) = tokio::fs::metadata(&f).await {
                if meta.is_file() && meta.len() > 0 {
                    return Some(f);
                }
            }
        }
        None
    }

    /// Downloads `url` into the cache while the player streams it, so the next
    /// play is local. Silently does nothing if the track is already cached or
    /// a download is in flight.
    pub async fn store(&self, track_id: &str, url: &str) -> Result<()> {
        if url.starts_with("file:") {
            return Ok(());
        }
        if self.hit(track_id).await.is_some() {
            return Ok(());
        }
        {
            let mut guard = self.inflight.lock().await;
            if !guard.insert(track_id.to_string()) {
                return Ok(());
            }
        }

        let result = self.download(track_id, url).await;

        self.inflight.lock().await.remove(track_id);
        result
    }

    async fn download(&self, track_id: &str, url: &str) -> Result<()> {
        self.ensure_dir().await?;
        let hls = url.contains(".m3u8");
        let dest = self.file_for(track_id, if hls { "m4a" } else { "mp3" });
        let part = dest.with_extension(if hls { "m4a.part" } else { "mp3.part" });

        let write = async {
            let mut sink = tokio::fs::File::create(&part)
                .await
                .with_context(|| format!("creating {}", part.display()))?;
            if hls {
                self.write_hls(&mut sink, url).await?;
            } else {
                self.write_body(&mut sink, url).await?;
            }
            sink.flush().await?;
            sink.sync_all().await?;
            drop(sink);
            tokio::fs::rename(&part, &dest).await?;
            Ok::<(), anyhow::Error>(())
        };

        if let Err(e) = write.await {
            // A partial file is worse than none: it would read as a cache hit.
            tokio::fs::remove_file(&part).await.ok();
            return Err(e);
        }
        Ok(())
    }

    async fn write_body(&self, sink: &mut tokio::fs::File, url: &str) -> Result<()> {
        let res = self.http.get(url).send().await?;
        if !res.status().is_success() {
            bail!("{} returned {}", url, res.status());
        }
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            sink.write_all(&chunk?).await?;
        }
        Ok(())
    }

    /// Rebuilds an HLS stream as one file: the `EXT-X-MAP` init segment (which
    /// carries the moov box) followed by every media segment in playlist order.
    async fn write_hls(&self, sink: &mut tokio::fs::File, manifest_url: &str) -> Result<()> {
        let manifest = self.fetch_text(manifest_url).await?;

        let mut parts: Vec<String> = Vec::new();
        for raw in manifest.lines() {
            let line = raw.trim();
            if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
                if let Some(c) = MAP_URI.captures(rest) {
                    if let Some(m) = c.get(1) {
                        parts.push(m.as_str().to_string());
                    }
                }
            } else if line.starts_with("http") {
                parts.push(line.to_string());
            }
        }
        if parts.is_empty() {
            bail!("empty HLS manifest");
        }
        for part in parts {
            self.write_body(sink, &part).await?;
        }
        Ok(())
    }

    // ------------------------------------------------------------- encrypted

    /// The cached encrypted stream for `track_id`, or `None`.
    ///
    /// The manifest comes back with `wf-local:<n>` where each media URI was,
    /// because only the webview can spell an asset-protocol URL. An entry
    /// missing any segment it references is reported as a miss rather than
    /// handed over half-broken.
    pub async fn hit_drm(&self, track_id: &str) -> Option<CachedDrmStream> {
        let dir = self.drm_dir(track_id);
        let text = tokio::fs::read_to_string(dir.join(DRM_MANIFEST)).await.ok()?;

        let mut names: Vec<String> = Vec::new();
        for c in LOCAL_REF.captures_iter(&text) {
            let name = c[1].to_string();
            if !names.contains(&name) {
                names.push(name);
            }
        }
        if names.is_empty() {
            return None;
        }

        let mut files = Vec::with_capacity(names.len());
        for name in &names {
            let path = dir.join(name);
            let meta = tokio::fs::metadata(&path).await.ok()?;
            if !meta.is_file() || meta.len() == 0 {
                return None;
            }
            files.push(path.to_string_lossy().into_owned());
        }

        let manifest = LOCAL_REF
            .replace_all(&text, |c: &regex::Captures| {
                let i = names.iter().position(|n| n == &c[1]).unwrap_or(0);
                format!("{LOCAL_SCHEME}{i}")
            })
            .into_owned();

        Some(CachedDrmStream { manifest, files })
    }

    /// Stores the encrypted stream behind `manifest_url` so the next play
    /// starts from disk.
    ///
    /// Unlike the plain formats this cannot be flattened into one file: the
    /// CDM is driven by Shaka, which needs the playlist - the key headers, the
    /// init segment, the segment boundaries. So the segments are saved
    /// individually and the manifest is rewritten to point at them.
    ///
    /// Nothing is decrypted. The bytes on disk are the ciphertext the CDN
    /// served, and a licence is still fetched from SoundCloud on every play.
    /// This is a transport cache, needed only because the CDN URLs carry an
    /// expiring signature that defeats the webview cache of its own.
    pub async fn store_drm(&self, track_id: &str, manifest_url: &str) -> Result<()> {
        if manifest_url.is_empty() {
            return Ok(());
        }
        if self.hit_drm(track_id).await.is_some() {
            return Ok(());
        }
        let key = format!("drm:{track_id}");
        {
            let mut guard = self.inflight.lock().await;
            if !guard.insert(key.clone()) {
                return Ok(());
            }
        }

        let result = self.download_drm(track_id, manifest_url).await;

        self.inflight.lock().await.remove(&key);
        result
    }

    async fn download_drm(&self, track_id: &str, manifest_url: &str) -> Result<()> {
        let dest = self.drm_dir(track_id);
        let staging = self
            .dir
            .join(DRM_DIR)
            .join(format!("{}.part", sanitise(track_id)));

        // A folder left by an interrupted run is stale, not a resumable state.
        tokio::fs::remove_dir_all(&staging).await.ok();
        tokio::fs::create_dir_all(&staging)
            .await
            .with_context(|| format!("creating {}", staging.display()))?;

        match self.fill_drm(&staging, manifest_url).await {
            Ok(n) => {
                tokio::fs::remove_dir_all(&dest).await.ok();
                tokio::fs::rename(&staging, &dest)
                    .await
                    .with_context(|| format!("finalising {}", dest.display()))?;
                tracing::info!("cached {n} encrypted segments for {track_id}");
                Ok(())
            }
            Err(e) => {
                // A half-filled folder would read as a hit, so it goes.
                tokio::fs::remove_dir_all(&staging).await.ok();
                Err(e)
            }
        }
    }

    /// Writes every segment into `dir` and the rewritten manifest beside them.
    /// Returns how many media segments were stored.
    async fn fill_drm(&self, dir: &Path, manifest_url: &str) -> Result<usize> {
        let mut base = manifest_url.to_string();
        let mut text = self.fetch_text(&base).await?;

        // SoundCloud hands out one media playlist per transcoding, but follow
        // a master down to its first variant rather than failing on one.
        if text.contains("#EXT-X-STREAM-INF") {
            let variant = text
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !l.starts_with('#'))
                .map(|l| absolutise(&base, l))
                .context("master playlist with no variant")?;
            text = self.fetch_text(&variant).await?;
            base = variant;
        }

        let mut out = String::with_capacity(text.len());
        let mut segments = 0usize;
        let mut maps = 0usize;
        let mut pending_range: Option<String> = None;
        // Where an offsetless `EXT-X-BYTERANGE` continues from, per resource.
        let mut cursor = (String::new(), 0u64);
        let mut ended = false;

        for raw in text.lines() {
            let line = raw.trim();

            if line.starts_with("#EXT-X-MAP:") {
                let uri = MAP_URI
                    .captures(line)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().to_string())
                    .context("EXT-X-MAP without a URI")?;
                let header = BYTERANGE_ATTR
                    .captures(line)
                    .and_then(|c| c.get(1))
                    .and_then(|m| range_of(m.as_str(), 0))
                    .map(|(h, _)| h);
                let name = format!("init{maps:03}.mp4");
                self.fetch_to(&dir.join(&name), &absolutise(&base, &uri), header.as_deref())
                    .await?;
                // BYTERANGE is dropped: the bytes it selected are the file.
                out.push_str(&format!("#EXT-X-MAP:URI=\"{LOCAL_SCHEME}{name}\"\n"));
                maps += 1;
                continue;
            }

            if line.starts_with("#EXT-X-KEY:") || line.starts_with("#EXT-X-SESSION-KEY:") {
                // The PlayReady header arrives as a `data:` URI and is kept
                // verbatim; anything else stays a network fetch and only needs
                // making absolute, since the manifest moves to a blob.
                out.push_str(&rewrite_uri(line, |u| {
                    if u.starts_with("data:") {
                        u.to_string()
                    } else {
                        absolutise(&base, u)
                    }
                }));
                out.push('\n');
                continue;
            }

            if let Some(spec) = line.strip_prefix("#EXT-X-BYTERANGE:") {
                pending_range = Some(spec.trim().to_string());
                continue;
            }

            if line == "#EXT-X-ENDLIST" {
                ended = true;
            }

            if line.is_empty() || line.starts_with('#') {
                out.push_str(line);
                out.push('\n');
                continue;
            }

            let url = absolutise(&base, line);
            let header = pending_range.take().and_then(|spec| {
                let from = if cursor.0 == url { cursor.1 } else { 0 };
                range_of(&spec, from).map(|(h, end)| {
                    cursor = (url.clone(), end);
                    h
                })
            });
            let name = format!("seg{segments:05}.m4s");
            self.fetch_to(&dir.join(&name), &url, header.as_deref())
                .await?;
            out.push_str(&format!("{LOCAL_SCHEME}{name}\n"));
            segments += 1;
        }

        if segments == 0 {
            bail!("no segments in the encrypted manifest");
        }
        // A stored copy is complete by definition. Without this Shaka reads
        // the playlist as live and re-fetches a manifest that is long gone.
        if !ended {
            out.push_str("#EXT-X-ENDLIST\n");
        }

        let manifest = dir.join(DRM_MANIFEST);
        tokio::fs::write(&manifest, out)
            .await
            .with_context(|| format!("writing {}", manifest.display()))?;
        Ok(segments)
    }

    async fn fetch_text(&self, url: &str) -> Result<String> {
        let res = self.http.get(url).send().await?;
        if !res.status().is_success() {
            bail!("{} returned {}", url, res.status());
        }
        Ok(res.text().await?)
    }

    /// Streams one resource into its own file. `range` narrows the fetch for a
    /// playlist that addresses segments by byte range.
    async fn fetch_to(&self, dest: &Path, url: &str, range: Option<&str>) -> Result<()> {
        let mut req = self.http.get(url);
        if let Some(r) = range {
            req = req.header(reqwest::header::RANGE, r);
        }
        let res = req.send().await?;
        if !res.status().is_success() {
            bail!("{} returned {}", url, res.status());
        }

        let mut sink = tokio::fs::File::create(dest)
            .await
            .with_context(|| format!("creating {}", dest.display()))?;
        let mut written = 0u64;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            written += chunk.len() as u64;
            sink.write_all(&chunk).await?;
        }
        sink.flush().await?;
        drop(sink);

        if written == 0 {
            bail!("{} returned no bytes", url);
        }
        Ok(())
    }

    // ---------------------------------------------------------- housekeeping

    pub async fn size(&self) -> u64 {
        let mut total = 0;
        let mut stack = vec![self.dir.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
                continue;
            };
            while let Ok(Some(entry)) = rd.next_entry().await {
                let Ok(meta) = entry.metadata().await else { continue };
                if meta.is_dir() {
                    stack.push(entry.path());
                } else if meta.is_file() {
                    total += meta.len();
                }
            }
        }
        total
    }

    /// Drops the least recently played entries until the store is back under
    /// `max_bytes`. Cheap enough to call after a track finishes loading.
    ///
    /// An encrypted track is a folder of segments and is evicted whole - half
    /// a stream will not play, and [`Self::hit_drm`] would reject it anyway.
    pub async fn trim(&self) -> Result<()> {
        let mut entries: Vec<(PathBuf, u64, std::time::SystemTime, bool)> = Vec::new();
        let mut total: u64 = 0;

        let Ok(mut rd) = tokio::fs::read_dir(&self.dir).await else {
            return Ok(());
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let Ok(meta) = entry.metadata().await else { continue };
            if !meta.is_file() {
                continue;
            }
            total += meta.len();
            entries.push((entry.path(), meta.len(), stamp_of(&meta), false));
        }

        if let Ok(mut rd) = tokio::fs::read_dir(self.dir.join(DRM_DIR)).await {
            while let Ok(Some(entry)) = rd.next_entry().await {
                let Ok(meta) = entry.metadata().await else { continue };
                if !meta.is_dir() {
                    continue;
                }
                let (bytes, stamp) = folder_stats(&entry.path()).await;
                total += bytes;
                entries.push((entry.path(), bytes, stamp, true));
            }
        }

        if total <= self.max_bytes {
            return Ok(());
        }
        // Access time is the LRU signal; on volumes where it is not
        // maintained, modification time is the next best thing. An in-flight
        // `.part` folder sorts last by construction, so it survives.
        entries.sort_by_key(|(_, _, stamp, _)| *stamp);
        for (path, len, _, is_dir) in entries {
            if total <= self.max_bytes {
                break;
            }
            let dropped = if is_dir {
                tokio::fs::remove_dir_all(&path).await.is_ok()
            } else {
                tokio::fs::remove_file(&path).await.is_ok()
            };
            if dropped {
                total -= len;
            }
        }
        Ok(())
    }

    /// Drops whatever is cached for `track_id`, in either shape.
    ///
    /// A stored copy that will not play is worse than none: it is tried
    /// first, fails, and only then falls back to the network. Forgetting it
    /// keeps that cost to the one play that discovered the problem.
    pub async fn forget(&self, track_id: &str) {
        for ext in EXTENSIONS {
            tokio::fs::remove_file(self.file_for(track_id, ext)).await.ok();
        }
        tokio::fs::remove_dir_all(self.drm_dir(track_id)).await.ok();
    }

    pub async fn clear(&self) -> Result<()> {
        match tokio::fs::remove_dir_all(&self.dir).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).context("clearing the audio cache"),
        }
    }
}

fn sanitise(id: &str) -> String {
    UNSAFE_CHARS.replace_all(id, "_").into_owned()
}

fn stamp_of(meta: &std::fs::Metadata) -> std::time::SystemTime {
    meta.accessed()
        .or_else(|_| meta.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

/// Bytes held by one cached stream folder, and the newest stamp in it.
async fn folder_stats(dir: &Path) -> (u64, std::time::SystemTime) {
    let mut bytes = 0;
    let mut newest = std::time::UNIX_EPOCH;
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return (0, newest);
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(meta) = entry.metadata().await else { continue };
        if !meta.is_file() {
            continue;
        }
        bytes += meta.len();
        let stamp = stamp_of(&meta);
        if stamp > newest {
            newest = stamp;
        }
    }
    (bytes, newest)
}

/// Replaces the `URI="..."` attribute of a tag line, leaving the rest of it
/// alone. A line without one comes back unchanged.
fn rewrite_uri(line: &str, f: impl FnOnce(&str) -> String) -> String {
    let Some(m) = MAP_URI.captures(line).and_then(|c| c.get(1)) else {
        return line.to_string();
    };
    let mut out = String::with_capacity(line.len());
    out.push_str(&line[..m.start()]);
    out.push_str(&f(m.as_str()));
    out.push_str(&line[m.end()..]);
    out
}

/// Resolves a playlist URI against the manifest it came from. SoundCloud emits
/// absolute URLs, so this is a safety net rather than the common path.
fn absolutise(base: &str, uri: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") || uri.starts_with("data:") {
        return uri.to_string();
    }
    let stem = base.split(['?', '#']).next().unwrap_or(base);

    if let Some(rest) = uri.strip_prefix('/') {
        // Root-relative: keep the scheme and host, drop the path.
        if let Some(scheme) = stem.find("://") {
            let after = scheme + 3;
            let end = stem[after..].find('/').map_or(stem.len(), |i| after + i);
            return format!("{}/{rest}", &stem[..end]);
        }
        return format!("{stem}/{rest}");
    }
    match stem.rfind('/') {
        Some(i) => format!("{}{uri}", &stem[..=i]),
        None => uri.to_string(),
    }
}

/// `<length>[@<offset>]` from an `EXT-X-BYTERANGE`, as an HTTP `Range` value
/// plus the offset an offsetless range would continue from. `None` when the
/// spec is unusable, which means "fetch the whole resource".
fn range_of(spec: &str, from: u64) -> Option<(String, u64)> {
    let mut parts = spec.trim().splitn(2, '@');
    let len: u64 = parts.next()?.trim().parse().ok()?;
    if len == 0 {
        return None;
    }
    let start: u64 = match parts.next() {
        Some(offset) => offset.trim().parse().ok()?,
        None => from,
    };
    Some((format!("bytes={}-{}", start, start + len - 1), start + len))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(tag: &str) -> (AudioCache, PathBuf) {
        let base = std::env::temp_dir().join(format!("wf-cache-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        (
            AudioCache::new(reqwest::Client::new(), &base, DEFAULT_MAX_BYTES),
            base,
        )
    }

    #[test]
    fn ids_are_sanitised_into_safe_filenames() {
        assert_eq!(sanitise("12345"), "12345");
        // One underscore per unsafe char: the space, then each of `/../`.
        assert_eq!(sanitise("sound cloud/../etc"), "sound_cloud____etc");
        assert_eq!(sanitise("soundcloud:playlists:9"), "soundcloud_playlists_9");
    }

    #[tokio::test]
    async fn hit_finds_m4a_before_mp3_and_ignores_empty_files() {
        let (c, base) = cache("hit");
        c.ensure_dir().await.unwrap();

        assert!(c.hit("1").await.is_none());

        // A zero-byte file is a failed download, not a hit.
        tokio::fs::write(c.file_for("1", "mp3"), b"").await.unwrap();
        assert!(c.hit("1").await.is_none());

        tokio::fs::write(c.file_for("1", "mp3"), b"data").await.unwrap();
        assert_eq!(c.hit("1").await.unwrap(), c.file_for("1", "mp3"));

        // The fMP4 copy is preferred when both exist.
        tokio::fs::write(c.file_for("1", "m4a"), b"data").await.unwrap();
        assert_eq!(c.hit("1").await.unwrap(), c.file_for("1", "m4a"));

        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn store_skips_local_files_and_existing_hits() {
        let (c, base) = cache("skip");
        c.ensure_dir().await.unwrap();

        // A file: URL is already local - nothing to fetch.
        c.store("1", "file:///c:/x.mp3").await.unwrap();
        assert!(c.hit("1").await.is_none());

        // An existing hit short-circuits before any network call, so this
        // unreachable host must not be contacted.
        tokio::fs::write(c.file_for("2", "mp3"), b"cached").await.unwrap();
        c.store("2", "https://127.0.0.1:9/nope.mp3").await.unwrap();

        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn trim_evicts_oldest_first_until_under_budget() {
        let base = std::env::temp_dir().join(format!("wf-cache-trim-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let c = AudioCache::new(reqwest::Client::new(), &base, 300);
        c.ensure_dir().await.unwrap();

        for (i, name) in ["old", "mid", "new"].iter().enumerate() {
            tokio::fs::write(c.file_for(name, "mp3"), vec![0u8; 200])
                .await
                .unwrap();
            // Space the timestamps so the sort is unambiguous.
            if i < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            }
        }
        assert_eq!(c.size().await, 600);

        c.trim().await.unwrap();
        assert!(c.size().await <= 300, "trim must get under the budget");
        assert!(c.hit("new").await.is_some(), "the newest file survives");
        assert!(c.hit("old").await.is_none(), "the oldest goes first");

        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn trim_is_a_noop_under_budget_and_clear_is_idempotent() {
        let (c, base) = cache("clear");
        c.ensure_dir().await.unwrap();
        tokio::fs::write(c.file_for("a", "mp3"), b"small").await.unwrap();

        c.trim().await.unwrap();
        assert!(c.hit("a").await.is_some(), "nothing is dropped under budget");

        c.clear().await.unwrap();
        assert_eq!(c.size().await, 0);
        // Clearing an already-gone directory must not error.
        c.clear().await.unwrap();

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn hls_map_uri_is_extracted_from_the_tag() {
        let line = r#"URI="https://cf-hls.sndcdn.com/init.mp4",BYTERANGE="0@0""#;
        let got = MAP_URI.captures(line).unwrap().get(1).unwrap().as_str();
        assert_eq!(got, "https://cf-hls.sndcdn.com/init.mp4");
    }

    // ------------------------------------------------------------- encrypted

    /// Writes the folder `store_drm` would have produced, without a network.
    async fn seed_drm(c: &AudioCache, track_id: &str) -> PathBuf {
        let dir = c.drm_dir(track_id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("init000.mp4"), b"moov").await.unwrap();
        tokio::fs::write(dir.join("seg00000.m4s"), b"aaaa").await.unwrap();
        tokio::fs::write(dir.join("seg00001.m4s"), b"bbbb").await.unwrap();
        tokio::fs::write(
            dir.join(DRM_MANIFEST),
            concat!(
                "#EXTM3U\n",
                "#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI=\"data:text/plain;base64,AAA\",",
                "KEYFORMAT=\"com.microsoft.playready\"\n",
                "#EXT-X-MAP:URI=\"wf-local:init000.mp4\"\n",
                "#EXTINF:10.0,\n",
                "wf-local:seg00000.m4s\n",
                "#EXTINF:10.0,\n",
                "wf-local:seg00001.m4s\n",
                "#EXT-X-ENDLIST\n",
            ),
        )
        .await
        .unwrap();
        dir
    }

    #[tokio::test]
    async fn hit_drm_numbers_the_placeholders_and_keeps_the_key_line() {
        let (c, base) = cache("drmhit");
        assert!(c.hit_drm("7").await.is_none(), "nothing cached yet");

        let dir = seed_drm(&c, "7").await;
        let entry = c.hit_drm("7").await.expect("a seeded folder is a hit");

        // First appearance wins the index, in playlist order.
        assert_eq!(
            entry.files,
            vec![
                dir.join("init000.mp4").to_string_lossy().into_owned(),
                dir.join("seg00000.m4s").to_string_lossy().into_owned(),
                dir.join("seg00001.m4s").to_string_lossy().into_owned(),
            ]
        );
        assert!(entry.manifest.contains("URI=\"wf-local:0\""));
        assert!(entry.manifest.contains("\nwf-local:1\n"));
        assert!(entry.manifest.contains("\nwf-local:2\n"));
        // The PlayReady header is passed through untouched.
        assert!(entry.manifest.contains("data:text/plain;base64,AAA"));
        assert!(!entry.manifest.contains("wf-local:seg"), "names are replaced");

        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn hit_drm_rejects_an_entry_with_a_missing_segment() {
        let (c, base) = cache("drmgap");
        let dir = seed_drm(&c, "8").await;

        tokio::fs::remove_file(dir.join("seg00001.m4s")).await.unwrap();
        assert!(
            c.hit_drm("8").await.is_none(),
            "a stream missing a segment is not playable"
        );

        // An empty file is a failed write, not a segment.
        tokio::fs::write(dir.join("seg00001.m4s"), b"").await.unwrap();
        assert!(c.hit_drm("8").await.is_none());

        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn store_drm_short_circuits_on_an_existing_hit() {
        let (c, base) = cache("drmskip");
        seed_drm(&c, "9").await;

        // Already cached, so this unreachable host must not be contacted.
        c.store_drm("9", "https://127.0.0.1:9/nope.m3u8").await.unwrap();
        assert!(c.hit_drm("9").await.is_some());

        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn forget_drops_both_shapes_and_tolerates_a_miss() {
        let (c, base) = cache("forget");
        c.ensure_dir().await.unwrap();

        // Forgetting a track that was never cached is not an error.
        c.forget("nothing").await;

        tokio::fs::write(c.file_for("6", "mp3"), b"data").await.unwrap();
        seed_drm(&c, "6").await;
        assert!(c.hit("6").await.is_some());
        assert!(c.hit_drm("6").await.is_some());

        c.forget("6").await;
        assert!(c.hit("6").await.is_none(), "the plain copy goes");
        assert!(c.hit_drm("6").await.is_none(), "the encrypted copy goes too");

        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn size_and_trim_account_for_encrypted_folders() {
        let base = std::env::temp_dir().join(format!("wf-cache-drmtrim-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let c = AudioCache::new(reqwest::Client::new(), &base, 300);
        c.ensure_dir().await.unwrap();

        // An old plain file, then a newer encrypted folder.
        tokio::fs::write(c.file_for("plain", "mp3"), vec![0u8; 200])
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let dir = c.drm_dir("enc");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("seg00000.m4s"), vec![0u8; 250])
            .await
            .unwrap();
        tokio::fs::write(dir.join(DRM_MANIFEST), "wf-local:seg00000.m4s\n")
            .await
            .unwrap();

        let total = c.size().await;
        assert!(total > 450, "nested segments count towards the size: {total}");

        c.trim().await.unwrap();
        assert!(c.size().await <= 300, "trim must reach into the drm folder");
        assert!(c.hit("plain").await.is_none(), "the oldest entry goes first");
        assert!(c.hit_drm("enc").await.is_some(), "the newest survives whole");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn relative_playlist_uris_resolve_against_the_manifest() {
        let base = "https://cf-hls.sndcdn.com/media/1/2/playlist.m3u8?Policy=abc";
        assert_eq!(
            absolutise(base, "https://other/seg.m4s"),
            "https://other/seg.m4s",
            "an absolute URI is left alone"
        );
        assert_eq!(
            absolutise(base, "seg0.m4s"),
            "https://cf-hls.sndcdn.com/media/1/2/seg0.m4s",
            "the query is dropped before joining"
        );
        assert_eq!(
            absolutise(base, "/other/seg0.m4s"),
            "https://cf-hls.sndcdn.com/other/seg0.m4s",
            "a root-relative URI keeps only the host"
        );
        assert_eq!(
            absolutise(base, "data:text/plain;base64,AA"),
            "data:text/plain;base64,AA"
        );
    }

    #[test]
    fn byte_ranges_become_http_range_headers() {
        assert_eq!(
            range_of("1024@512", 0),
            Some(("bytes=512-1535".into(), 1536)),
            "an explicit offset wins"
        );
        assert_eq!(
            range_of("100", 1536),
            Some(("bytes=1536-1635".into(), 1636)),
            "an offsetless range continues from the cursor"
        );
        assert_eq!(range_of("0@0", 0), None, "a zero length means fetch it whole");
        assert_eq!(range_of("nonsense", 0), None);
    }

    #[test]
    fn rewriting_a_uri_leaves_the_other_attributes_alone() {
        let line = r#"#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="key.bin",KEYFORMAT="playready""#;
        let got = rewrite_uri(line, |u| format!("https://host/{u}"));
        assert_eq!(
            got,
            r#"#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="https://host/key.bin",KEYFORMAT="playready""#
        );
        assert_eq!(rewrite_uri("#EXTINF:10.0,", |_| "x".into()), "#EXTINF:10.0,");
    }
}
