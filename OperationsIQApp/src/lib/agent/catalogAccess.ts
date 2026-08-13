/**
 * Build a {@link CatalogAccess} bound to a Connection Profile and delegated
 * token. This is the seam that lets the agent's catalog tools (`resolve_tags`,
 * `describe_tag`, `browse_asset_hierarchy`) query the scalable server-backed
 * catalog service instead of scanning the full in-memory `ctx.tags` array.
 *
 * It is injected into the ToolContext only for LARGE catalogs (see
 * OperationsAdvisorPanel); when absent the tools fall back to the in-memory
 * scan, so small-catalog behavior is unchanged. Every call runs through
 * `lib/catalog.ts` under the user's token, so RLS is preserved exactly as the
 * in-memory path was.
 *
 * The service's result shapes (`SearchTagsResult`, `CatalogValue`) are
 * structurally identical to the tool-facing `CatalogSearchPage` /
 * `CatalogValueCount`, so results pass through untouched.
 */

import type { ConnectionProfile, KqlOptions } from '../connectionProfile';
import type { CatalogAccess } from './types';
import {
  countTags,
  getHierarchyChildren,
  getTagsByIds,
  searchTags,
} from '../catalog';

export function createCatalogAccess(
  profile: ConnectionProfile,
  opts?: KqlOptions,
): CatalogAccess {
  return {
    searchTags: (params, signal) => searchTags(profile, params, opts, { signal }),
    getTagsByIds: (ids, signal) => getTagsByIds(profile, ids, opts, { signal }),
    getHierarchyChildren: (params, signal) =>
      getHierarchyChildren(profile, params, opts, { signal }),
    countTags: (filter, signal) => countTags(profile, filter, opts, { signal }),
  };
}
