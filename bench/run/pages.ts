/** The benchmark pages (performance notes §4, testing notes §3 family `perf/`), served by the fixture server. */
export const BENCH_PAGES = ['blank', 'article', 'adheavy-1', 'adheavy-2', 'adheavy-3', 'dom-5000', 'infinite-scroll', 'spa'] as const;

const HOST = 'news.bench.example';

export const pageUrl = (page: string): string => `https://${HOST}/perf/${page}.html`;
