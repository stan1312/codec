// Binds one <video> element to the master clock (framework-free).
//
// const vs = attachVideoSync(videoEl, startMs, { onUserSeek, onUserPlay, onUserPause, onStatus });
// vs.update(playbackState)   // call on every master-clock change
// vs.setEnabled(bool)
// vs.destroy()
//
// User actions on the element's native controls are reported through the
// callbacks so they can drive the master clock; actions triggered by the
// sync itself are filtered out.
import { syncDecision, mediaTimeFor, masterTimeFor } from "./sync.js";

export function attachVideoSync(video, startMs, cb = {}) {
  let enabled = true;
  let lastJump = null;
  let lastState = null;
  let status = "sync";
  let programmaticSeek = 0;
  let programmaticPlayState = 0;

  function setStatus(s) {
    if (s !== status) {
      status = s;
      cb.onStatus && cb.onStatus(s);
    }
  }

  function update(p) {
    lastState = p;
    if (!enabled || !p || !Number.isFinite(p.time)) return;
    if (video.readyState < 1) return; // metadata not loaded yet
    const target = mediaTimeFor(p.time, startMs);
    const jumped = p.jump !== lastJump;
    lastJump = p.jump;
    const d = syncDecision(
      { currentTime: video.currentTime, duration: video.duration, paused: video.paused },
      target,
      p.playing,
      p.rate,
      jumped ? { seekThreshold: 0.05 } : {},
    );
    setStatus(d.status === "before" || d.status === "after" ? d.status : "sync");
    if (d.seekTo !== undefined && !video.seeking) {
      programmaticSeek++;
      video.currentTime = d.seekTo;
    }
    if (Math.abs(video.playbackRate - d.playbackRate) > 0.001) {
      video.playbackRate = d.playbackRate;
    }
    if (d.play && video.paused && !video.seeking) {
      programmaticPlayState++;
      const pr = video.play();
      if (pr && pr.catch) {
        pr.catch(() => {
          programmaticPlayState = Math.max(0, programmaticPlayState - 1);
        });
      }
    }
    if (d.pause && !video.paused) {
      programmaticPlayState++;
      video.pause();
    }
  }

  function onSeeked() {
    if (programmaticSeek > 0) {
      programmaticSeek--;
      return;
    }
    if (enabled && status === "sync" && cb.onUserSeek) {
      cb.onUserSeek(masterTimeFor(video.currentTime, startMs));
    }
  }
  function onPlay() {
    if (programmaticPlayState > 0) {
      programmaticPlayState--;
      return;
    }
    if (enabled && cb.onUserPlay) cb.onUserPlay();
  }
  function onPause() {
    if (programmaticPlayState > 0) {
      programmaticPlayState--;
      return;
    }
    // reaching the end of the file is not a user pause
    if (enabled && !video.ended && cb.onUserPause) cb.onUserPause();
  }
  function onMeta() {
    lastJump = null;
    update(lastState);
  }

  video.addEventListener("seeked", onSeeked);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("loadedmetadata", onMeta);

  return {
    update,
    get status() {
      return status;
    },
    setEnabled(on) {
      enabled = on;
      if (on) {
        lastJump = null;
        update(lastState);
      } else {
        setStatus("sync");
        video.playbackRate = 1;
      }
    },
    setStart(ms) {
      startMs = ms;
      lastJump = null;
      update(lastState);
    },
    destroy() {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("loadedmetadata", onMeta);
    },
  };
}
