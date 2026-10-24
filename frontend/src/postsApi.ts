// Backend calls for per-platform posts (backend/app/services/post_writer.py).
import { post } from "./backend";
import type { PostVariants, Publication, QualityCheck } from "./types";

export const postsApi = {
  /** (Re)write every platform version and re-run the quality check. */
  prepare: (answerId: string) =>
    post<{ variants: PostVariants; quality: QualityCheck[] }>(
      `/api/answers/${answerId}/prepare`,
    ),
  /** Publish; force=true posts even if the quality check flagged the text. */
  publish: (answerId: string, platforms: string[], force = false) =>
    post<{ publications: Publication[] }>(`/api/answers/${answerId}/publish`, {
      platforms,
      force,
    }),
};

/** Character limits shown next to each version (Bluesky counts the link label too). */
export const PLATFORM_LIMITS: Record<string, number> = {
  bluesky: 300 - "Full answer".length,
  linkedin: 3000,
  reddit: 10000,
  quora: 10000,
  discourse: 32000,
};
