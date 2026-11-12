/**
 * 長い同期処理の途中でメインスレッドへ処理を譲る（INP 対策）。
 * scheduler.yield() は続きをタスクキューの先頭に置くので、譲っても後回しになりにくい。
 * 未対応ブラウザは setTimeout にフォールバックする。
 */
export function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * ループの各反復で await する関数を返す。前回譲ってから budgetMs を超えたときだけ譲るので、
 * 反復ごとに呼んでもオーバーヘッドは小さい。
 */
export function yielder(budgetMs = 40): () => Promise<void> | void {
  let last = performance.now();
  return () => {
    if (performance.now() - last < budgetMs) return;
    return yieldToMain().then(() => {
      last = performance.now();
    });
  };
}
