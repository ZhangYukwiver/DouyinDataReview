import type { PersonalVideoRecord } from "./personalRecords";

// Shared by the desktop collector client and the Android app, which read the same watch-history API.
// How the web player writes history (checked by scrolling the feed and reading its requests):
// - entering a video for the first time writes a record about a second later, even for a half-second flick;
// - scrolling back to a video already seen writes nothing;
// - leaving a video that played past ~90–95% moves its record to the moment it was left, a millisecond before
//   the next video's record, and Douyin marks that viewing as watched to the end (watchCompleted).
// So a marked video is 100%, and the rest are timed from their record to the next one. Records under a second
// apart are a scroll that went one video too far and came back: the first is the one watched, the others were
// flicked past. A marked video's record is when it was left, so the video before it ended at least 90% of the
// marked one's length earlier. Gaps over five minutes mean the app was closed or paused.
export function estimateWatchProgress(records: PersonalVideoRecord[]): void {
  for (const record of records) {
    if (record.watchCompleted && record.mediaType === "video" && record.durationSeconds) {
      record.watchProgress = { watchedSeconds: record.durationSeconds, percent: 100 };
    }
  }
  const timed = records
    .filter((record) => record.occurredAtSource !== "unknown" && record.occurredAt)
    .map((record) => ({ record, at: Date.parse(record.occurredAt!) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);
  // Records saved before the label existed: a record followed within 3 ms by another video is that rewrite
  // (79 of 80 such pairs Douyin labelled were finished).
  const finished = (index: number) => {
    const { record, at } = timed[index]!;
    if (record.watchCompleted !== undefined) return record.watchCompleted;
    const next = timed[index + 1];
    return Boolean(next && next.at - at <= 3 && next.record.videoId !== record.videoId);
  };
  timed.forEach(({ record }, index) => {
    if (finished(index) && record.mediaType === "video" && record.durationSeconds) {
      record.watchProgress = { watchedSeconds: record.durationSeconds, percent: 100 };
    }
  });
  // a record within 3 ms of the one before is the next video entered, never a flick
  const flickedPast = (index: number) => {
    const gap = timed[index]!.at - timed[index - 1]!.at;
    return gap > 3 && gap < 1_000;
  };
  for (let index = 0; index < timed.length - 1; index += 1) {
    const { record, at } = timed[index]!;
    const duration = record.durationSeconds;
    if (record.watchProgress || record.mediaType !== "video" || !duration) continue;
    const flicked = index > 0 && flickedPast(index);
    let end = index + 1;
    if (!flicked) while (end < timed.length - 1 && flickedPast(end) && !finished(end)) end += 1;
    // the newest burst has nothing after it yet, so it is still unknown when the watched one ended
    if (!flicked && flickedPast(end) && !finished(end)) continue;
    const next = timed[end]!;
    // a video flicked past was on screen for the shorter of the gaps around it, both under a second
    let dwell = (flicked ? Math.min(next.at - at, at - timed[index - 1]!.at) : next.at - at) / 1_000;
    if (!flicked && finished(end) && next.record.videoId !== record.videoId) {
      dwell -= 0.9 * (next.record.durationSeconds ?? Infinity);
    }
    // a watched video can't end within a second of starting unless the labels disagree with the timing
    if (!(dwell >= 0) || dwell > 300 || (!flicked && dwell < 1)) continue;
    // Douyin says this one was not watched to the end, however long it stayed on screen
    const ceiling = record.watchCompleted === false ? 90 : 100;
    const percent = Math.min(ceiling, dwell / duration * 100);
    record.watchProgress = {
      watchedSeconds: Math.round(Math.min(dwell, duration * percent / 100) * 100) / 100,
      percent: Math.round(percent * 100) / 100,
    };
  }
}
