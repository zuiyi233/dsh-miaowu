import { useEffect, useRef, useState } from "react";
import {
  PLAYBACK_IMAGE_SECONDS_DEFAULT,
  PLAYBACK_IMAGE_SECONDS_MAX,
  PLAYBACK_IMAGE_SECONDS_MIN,
  assemblePlaybackShots,
  clampPlaybackImageSeconds,
  playbackImageDelayMs,
  playbackNextIndex,
  playbackPromptSnippet,
  playbackShouldStop,
  schedulePlaybackImageAdvance,
  selectedVersionForTarget,
  type PlaybackAdvanceReason,
  type PlaybackShot,
  type ProductionMediaVersion
} from "./production-runtime.js";
import { endpoint } from "./workbench-ui.js";
import type { DramaEpisodeProduction } from "./drama-production.js";

interface Props {
  readonly sessionId: string;
  readonly production: DramaEpisodeProduction;
  readonly versions: readonly ProductionMediaVersion[];
  readonly selections: Readonly<Record<string, string>>;
  readonly episodeName: string;
}

/**
 * EP 内按镜头顺序串播:每镜头展示已选产物(视频优先,图片兜底,无产物占位),
 * 下方显示分镜条目已有的目的/景别/起终与提示词摘要。图片按可调秒数自动
 * 切镜,视频播完切下一镜,末镜停住。有台词配音的镜头在舞台下方渲染
 * <audio controls>;自动播放时图片镜头的配音随切镜自动播放,视频镜头不叠
 * 加配音(视频自带声音优先);无配音镜头静默。
 */
export function DramaPlayback({ sessionId, production, versions, selections, episodeName }: Props) {
  const shots = usePlaybackShots(production, versions, selections);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [imageSeconds, setImageSeconds] = useState(PLAYBACK_IMAGE_SECONDS_DEFAULT);
  const total = shots.length;
  const current: PlaybackShot | undefined = shots[Math.min(index, Math.max(0, total - 1))];

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [production.episodeDirectory]);

  const advance = (reason: PlaybackAdvanceReason): void => {
    setIndex((value) => {
      const next = playbackNextIndex(value, total, reason);
      if (reason !== "next" && reason !== "prev" && playbackShouldStop(total, next)) setPlaying(false);
      return next;
    });
  };

  const currentRef = useRef(current);
  currentRef.current = current;
  const hasVideo = current?.video !== undefined;
  useEffect(() => {
    if (!playing || total === 0 || hasVideo) return;
    return schedulePlaybackImageAdvance(() => {
      setIndex((value) => {
        const next = playbackNextIndex(value, total, "image-timer");
        if (playbackShouldStop(total, next)) setPlaying(false);
        return next;
      });
    }, imageSeconds);
  }, [playing, index, total, imageSeconds, hasVideo]);

  if (total === 0) {
    return <section className="oh-story-playback" aria-label="短剧串播">
      <div className="oh-story-production-empty">
        <strong>本集还没有可串播的镜头。</strong>
        <p>在右侧 Chat 用 /short-drama-storyboard 写好{episodeName} 的分镜.md 后,这里会按镜头顺序串播。已有产物会直接显示,缺产物的镜头显示占位。</p>
      </div>
    </section>;
  }
  const shot = current ?? shots[0]!;
  const position = Math.min(index, total - 1);
  const dubUrl = shot.video === undefined && shot.audio !== undefined && shot.audio.length > 0 ? endpoint("media", sessionId, shot.audio[0]!.path) : undefined;
  return <section className="oh-story-playback" aria-label="短剧串播" tabIndex={0} onKeyDown={(event) => {
    if (event.key === "ArrowRight") { event.preventDefault(); advance("next"); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); advance("prev"); }
  }}>
    <div className="oh-story-playback-stage">
      {shot.video !== undefined
        ? <video className="oh-story-playback-media" key={shot.video.id} src={shot.video.url} controls autoPlay={playing} preload="metadata" onEnded={() => { if (playing) advance("video-ended"); }} />
        : shot.image !== undefined
          ? <img className="oh-story-playback-media" key={shot.image.id} src={shot.image.url} alt={shot.shotId} />
          : <div className="oh-story-playback-placeholder"><strong>{shot.shotId}</strong><span>{playbackPromptSnippet(shot.promptSummary) ?? "该镜头暂无已生成产物"}</span></div>}
    </div>
    {dubUrl !== undefined && <audio className="oh-story-playback-dub" key={`${shot.shotId}:${shot.audio![0]!.path}`} src={dubUrl} controls autoPlay={playing} preload="metadata" aria-label={`${shot.shotId} 台词配音`} />}
    <div className="oh-story-playback-caption">
      <strong>{String(position + 1).padStart(2, "0")} / {String(total)} · {shot.shotId} {shot.title}</strong>
      {shot.caption !== undefined && <p>{shot.caption}</p>}
      {shot.promptSummary !== undefined && <p className="oh-story-playback-prompt">{playbackPromptSnippet(shot.promptSummary, 96)}</p>}
    </div>
    <div className="oh-story-playback-controls">
      <button type="button" aria-label="上一个镜头" disabled={position === 0} onClick={() => { advance("prev"); }}>← 上一镜</button>
      <button type="button" aria-pressed={playing} onClick={() => { setPlaying((value) => total > 1 && !value); }} disabled={total < 2}>{playing ? "暂停" : "自动播放"}</button>
      <button type="button" aria-label="下一个镜头" disabled={position >= total - 1} onClick={() => { advance("next"); }}>下一镜 →</button>
      <label>图片停留
        <input aria-label="图片每镜停留秒数" type="number" min={PLAYBACK_IMAGE_SECONDS_MIN} max={PLAYBACK_IMAGE_SECONDS_MAX} value={imageSeconds} onChange={(event) => { setImageSeconds(clampPlaybackImageSeconds(Number(event.target.value))); }} />
        秒
      </label>
      <span className="oh-story-playback-hint">图片 {playbackImageDelayMs(imageSeconds) / 1000}s/镜 · 视频播完自动切镜 · ←/→ 切换</span>
    </div>
    <ol className="oh-story-playback-filmstrip" aria-label="镜头顺序">
      {shots.map((item, itemIndex) => <li key={item.shotId}><button type="button" aria-current={itemIndex === position} aria-label={`跳到镜头 ${item.shotId}`} data-current={itemIndex === position || undefined} onClick={() => { setIndex(itemIndex); }}>{String(itemIndex + 1).padStart(2, "0")}</button></li>)}
    </ol>
  </section>;
}

/** 分镜文档顺序即播放顺序;产物用镜头板的已选版本规则,不重写 token 匹配。 */
export function usePlaybackShots(
  production: DramaEpisodeProduction,
  versions: readonly ProductionMediaVersion[],
  selections: Readonly<Record<string, string>>
): PlaybackShot[] {
  const [shots, setShots] = useState<PlaybackShot[]>(() => assemblePlaybackShots(toPlaybackSources(production), versions, selections));
  const selectedVideo = currentSelectedVideoId(production, versions, selections);
  useEffect(() => {
    setShots(assemblePlaybackShots(toPlaybackSources(production), versions, selections));
  }, [production, versions, selections, selectedVideo]);
  return shots;
}

function toPlaybackSources(production: DramaEpisodeProduction) {
  return production.shots.map((shot) => ({
    id: shot.id,
    title: shot.title,
    purpose: shot.purpose,
    shotSpec: shot.shotSpec,
    start: shot.start,
    end: shot.end,
    keyframePrompt: shot.keyframePrompt,
    motionPrompt: shot.motion?.prompt,
    ...(shot.audio === undefined ? {} : { audio: shot.audio })
  }));
}

function currentSelectedVideoId(
  production: DramaEpisodeProduction,
  versions: readonly ProductionMediaVersion[],
  selections: Readonly<Record<string, string>>
): string {
  return production.shots.map((shot) => selectedVersionForTarget(shot.id, versions, selections, "video")?.id ?? "").join("|");
}
