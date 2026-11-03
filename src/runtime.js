import path from "node:path";
import { loadManifest } from "./manifest.js";
import { Store } from "./store.js";

export function runtime(manifestPath, dataRoot) {
  const loaded=loadManifest(manifestPath), root=dataRoot || process.env.HH_DATA_DIR || path.join(process.cwd(),".hackharness-data");
  const store=new Store(root), existing=store.engagement(loaded.manifest.engagement);
  if (!existing) store.createEngagement(loaded.absolute,loaded.manifest);
  return {store,manifest:loaded.manifest,manifestPath:loaded.absolute};
}
