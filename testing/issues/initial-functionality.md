


1. When gallery mode is open, clicking on an image should not close gallery mode it should just put that image in the preview area, and the gallery should be scrolled to the top of the selected image. AND GALLERY MUST STAY OPEN
- currently it immediately closes the gallery and opens the image in the preview area, which is not the desired behavior. The gallery should stay open and the selected image should be displayed in the preview area.
- This allows users to scroll through the gallery and wacth their images in like a slideshow without having to open and close the gallery each time they want to view an image.
- also the header should be smart and size responsive, if the window is smaller it should hide the many action buttons behind a "..." menu, and if the window is larger it should show all the action buttons in the header. This is to make the app more responsive and user friendly.
- also doubletapping the header should snap the window to fit the screen using the macos window snapping feature, and doubletapping the header again should restore the window to its previous size. This is to make the app more responsive and user friendly.
2. Need to complete the async / threading work to make the app more responsive.
    - async / threading — what's left

| Path | Today | Fix | Leverage |
|---|---|---|---|
| `scan_folder` (`gallery.rs`) | **Still sync → main thread.** Does N `stat()` calls serially. Fine for 12 files; a 5k-file folder blocks the UI for a noticeable beat | `async` + `spawn_blocking`, and `rayon` `par_iter` over the dir entries for `build_entry` | Medium — the last main-thread blocker |
| Batch thumbnail prewarm | None — thumbnails are pulled one-per-IPC as tiles scroll in | A `prewarm_folder` command that `rayon`-parallelizes cold decodes across all cores, fired once after a scan | **High** — turns your 60–75s-serial cold open into `total/num_cores`, and fills the grid without per-tile IPC latency (this is the spec §10 item) |
| `showSibling` / arrow-key nav | Re-reads dimensions+EXIF on every step | Prefetch next/prev entry; reuse cached dims | Low |

3. Some other performance optimizations:
```md
1. **Downscale-on-decode for thumbnails** — the real cold-path cost is *full decode*: `load_oriented` decodes an 18MP image in full, then throws away 99% to make 256px. For **JPEG** you can decode at 1/2–1/8 DCT scale (≈orders faster) — but that needs a decoder that exposes it (`turbojpeg`/libjpeg-turbo, or `zune-jpeg` directly); the `image` 0.25 high-level API doesn't. **Caveat for your workload:** your files are **PNG**, and PNG has no scaled decode — so for *this* folder the win is parallelism (prewarm), not scaled decode. Worth it later for JPEG photo libraries.
2. **EXIF-embedded thumbnails** — most camera JPEGs embed a ~160px preview; `kamadak-exif` can pull it and skip decode entirely. Near-instant grids for photo folders. (Again, no effect on PNG assets.)
3. **Two-tier viewer image** — opening a large photo loads the **full-res original** straight into the webview (`Viewer.tsx: assetUrl(current.path)`). An 18MP image is ~72MB RGBA in webview memory and a heavy decode. Serve a screen-resolution preview (≤~2560px) for display and only swap to full-res when zoomed &gt;100%. Big memory + open-latency win for large images.
4. **Fold dimension-probing into thumbnail generation** — record `w×h` when you generate the thumbnail so the gallery lays out without a separate `image_dimensions` read.
```



Logs:

```log
[2026-07-21 19:14:04] bun tauri:dev
$ bun run --cwd apps/pics-rs tauri dev
$ tauri dev
     Running BeforeDevCommand (`bun run dev`)
$ vite

  VITE v6.4.3  ready in 303 ms

  ➜  Local:   http://localhost:1420/
     Running DevCommand (`cargo  run --no-default-features --color always --`)
        Info Watching /Users/yacqubabdirahman/Repos/OpenSource/pics-rs/apps/pics-rs/src-tauri for changes...
   Compiling logger-rs v0.1.0 (/Users/yacqubabdirahman/Repos/OpenSource/pics-rs/packages/logger-rs)
   Compiling pics-rs v0.1.0 (/Users/yacqubabdirahman/Repos/OpenSource/pics-rs/apps/pics-rs/src-tauri)
warning: constant `DATALESS_SENTINEL` is never used
  --> src/error.rs:10:11
   |
10 | pub const DATALESS_SENTINEL: &str = "E_DATALESS";
   |           ^^^^^^^^^^^^^^^^^
   |
   = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: `pics-rs` (lib) generated 1 warning
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 9.55s
     Running `target/debug/pics-rs`
[19:14:20] [INFO] [lib.rs:startup] pics-rs started; logging to /Users/yacqubabdirahman/Library/Logs/dev.picsrs.app/pics-rs.log
[19:14:45] [INFO] [gallery.rs:scan_folder] found 10 supported image(s)
[19:14:45] [INFO] [gallery.rs:scan_folder] Scanning folder /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons took 753µs
[19:14:45] [DEBUG] [thumbnail.rs:get_thumbnail] cache hit (256px) for /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons/[Dark]-App-Icon-Gradient-700.png
[19:14:45] [DEBUG] [thumbnail.rs:get_thumbnail] cache hit (256px) for /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons/[Dark]-App-Icon-Gradient.png
[19:14:45] [DEBUG] [thumbnail.rs:get_thumbnail] cache hit (256px) for /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons/[Dark]-App-Icon-Rounded.png
[19:14:45] [DEBUG] [thumbnail.rs:get_thumbnail] cache hit (256px) for /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons/[Dark]-App-Icon.png
[19:14:47] [DEBUG] [thumbnail.rs:get_thumbnail] cache hit (256px) for /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons/[Light]-App-Icon-Gradient-700.png
[19:14:48] [DEBUG] [thumbnail.rs:get_thumbnail] cache hit (256px) for /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons/[Light]-App-Icon-Gradient-700.png
[19:14:49] [DEBUG] [thumbnail.rs:get_thumbnail] cache hit (256px) for /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons/[Light]-App-Icon-Gradient-700.png
[19:14:52] [INFO] [mod.rs:read_image_entry] Read image entry /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons/[Dark]-App-Icon-Gradient-700.png took 5.5ms
[19:14:52] [INFO] [gallery.rs:scan_folder] found 10 supported image(s)
[19:14:52] [INFO] [gallery.rs:scan_folder] Scanning folder /Users/yacqubabdirahman/Repos/Expo/seriph-expo-52/assets/icons took 519µs
```


Seems like on the folders with icloud images (not on disk at the moment), the thumbnails are not available, 
when I open the finder in that same folder, the thumbnails are displayed
![alt text](image.png)

```log
[19:21:27] [INFO] [gallery.rs:scan_folder] found 16 supported image(s)
[19:21:27] [INFO] [gallery.rs:scan_folder] Scanning folder /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos took 1.3ms
[19:21:27] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/22DC25F9-3D6F-439A-B850-92A84A7198B4.jpg
[19:21:27] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC06741.jpg
[19:21:27] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC06751-2.jpg
[19:21:27] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC06760.jpg
[19:21:37] [INFO] [thumbnail.rs:get_thumbnail] Generating 256px thumbnail for /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC06736.jpg took 9.54s
[19:21:44] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC07822-2.jpg
[19:22:17] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC07822-2.jpg
[19:22:17] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC07822.jpg
[19:22:17] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC07841-2.jpg
[19:22:17] [WARN] [thumbnail.rs:get_thumbnail] iCloud placeholder not downloaded, skipping thumbnail: /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC07841.jpg
[19:22:33] [INFO] [mod.rs:read_image_entry] Read image entry /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC06736.jpg took 77.91s
[19:22:33] [INFO] [mod.rs:read_image_entry] Read image entry /Users/yacqubabdirahman/Documents/Documents - MacBook/Business/Content/Photos/Edited Photos/DSC06736.jpg took 81.79s
```

does the OS get the thumnails from somehwere else? can we also get them for our list?

Also when I click an image that is not downloaded from icloud, 
    - The app does not give me any feedback that the image is being downloaded, 
    - After the first click it downloads the image in the bg and then nothing happens
    - After the second click it opens the image in the preview area, but no inidctaion to the user that the image is being downloaded, 
    - It should show the downloading progress to the user, and then open the image in the preview area once the download is complete.
    - No need for a second click, the first click should trigger the download and then open the image in the preview area once the download is complete.