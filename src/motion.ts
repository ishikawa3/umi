/**
 * 常時動き続ける描画（明滅・粒子）の共通ループ。
 *
 * - OSの「視差効果を減らす／動きを減らす」設定（prefers-reduced-motion）を尊重し、
 *   既定では静止画で描く。設定は実行中の変更にも追従する。
 * - WCAG 2.2.2（一時停止・停止・非表示）: 5秒以上続く自動アニメーションには
 *   止める手段が要る。prefers-reduced-motion はその代わりにならないため、
 *   作品ナビに「とめる／うごかす」ボタンを置く。動きを減らす設定の人も
 *   このボタンで動きを選んで見られる。
 * - 選択はページをまたいで保つ（閲覧者ごとの好みなので localStorage。使えない環境では無視）。
 */

const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
const STORE_KEY = "umi:motion";

type Choice = "play" | "pause" | null;

function readChoice(): Choice {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === "play" || v === "pause" ? v : null;
  } catch {
    return null;
  }
}
function writeChoice(c: Choice) {
  try {
    if (c) localStorage.setItem(STORE_KEY, c);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* プライベートウィンドウ等: 保存できなくても動作は続ける */
  }
}

/** いまアニメーションしてよいか（利用者の明示的な選択 > OS設定） */
export function motionAllowed(): boolean {
  const c = readChoice();
  return c ? c === "play" : !mq.matches;
}

export interface AmbientLoop {
  /** 止まっているときに1枚だけ描き直す（リサイズ・ハイライト変更など） */
  redraw(): void;
  readonly running: boolean;
}

/**
 * @param frame 毎フレームの描画。ts は rAF のタイムスタンプ、dt は秒（上限0.1）
 * @param still 静止時の描画。省略時は frame(最後のts, 0) を1回呼ぶ。
 *   直前のフレームをそのまま残したいページは空関数を渡す
 */
export function ambientLoop(
  frame: (ts: number, dt: number) => void,
  still?: () => void,
): AmbientLoop {
  let running = false;
  let raf = 0;
  let lastTs = performance.now();

  const drawStill = () => (still ? still() : frame(lastTs, 0));

  const tick = (ts: number) => {
    // 再開直後の最初の rAF の ts（フレーム開始時刻）は、直前に記録した performance.now() より
    // 前になりうる。負の dt で時刻や粒子が逆戻りしないよう 0 以上に丸める
    const dt = Math.min(Math.max(0, (ts - lastTs) / 1000), 0.1);
    lastTs = ts;
    frame(ts, dt);
    raf = requestAnimationFrame(tick);
  };

  const apply = () => {
    const want = motionAllowed();
    if (want && !running) {
      running = true;
      lastTs = performance.now();
      raf = requestAnimationFrame(tick);
    } else if (!want) {
      running = false;
      cancelAnimationFrame(raf);
      drawStill();
    }
    syncButton();
  };

  // ---- 「とめる／うごかす」ボタン（作品ナビの末尾） ----
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "motion-toggle";
  const syncButton = () => {
    // ラベル自体が状態を表すので aria-pressed は付けない（「押された うごかす」と読まれるため）
    // 読み上げ名には表示中の文字をそのまま含める（音声操作で「とめる」と言って押せるように。WCAG 2.5.3）
    btn.textContent = running ? "とめる" : "うごかす";
    btn.setAttribute("aria-label", running ? "とめる（アニメーション）" : "うごかす（アニメーション）");
  };
  btn.addEventListener("click", () => {
    const next: Choice = running ? "pause" : "play";
    // OS設定と同じ結果になる選択は保存しない（設定変更に素直に追従させる）
    writeChoice((next === "play") === !mq.matches ? null : next);
    apply();
  });
  const nav = document.querySelector(".hud-nav");
  (nav ?? document.body).appendChild(btn);

  mq.addEventListener("change", apply);
  // 他ページ（別タブ）で切り替えたら追従
  window.addEventListener("storage", (e) => {
    if (e.key === STORE_KEY) apply();
  });

  apply();

  return {
    redraw() {
      if (!running) drawStill();
    },
    get running() {
      return running;
    },
  };
}
