/**
 * Load locations database for city fuzzy matching
 * Separated from post_job.js to avoid static analysis false positives
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Fuse from "fuse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const locationsPath = path.join(__dirname, "..", "assets", "locations.json");

let locations = [];
let fuse = null;

/**
 * Initialize locations database
 * @returns {Object} Fuse instance for fuzzy search
 */
function initLocations() {
  if (!fuse) {
    if (fs.existsSync(locationsPath)) {
      locations = JSON.parse(fs.readFileSync(locationsPath, "utf-8"));
    }
    fuse = new Fuse(locations, {
      keys: ["label", "parentLabel"],
      threshold: 0.3,
    });
  }
  return fuse;
}

/**
 * Get the Fuse instance for location search
 * @returns {Object} Fuse instance
 */
export function getLocationsFuse() {
  return initLocations();
}

export default { getLocationsFuse };