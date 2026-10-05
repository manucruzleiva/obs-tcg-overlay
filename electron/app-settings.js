/**
 * Desktop-app preferences (not match state): a tiny JSON file in the user-data folder.
 *
 * Kept separate from main.js and free of Electron imports so it can be unit tested.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Closing the window hides it to the tray (next to the clock) and keeps the overlay service running
  keepInTray: true,
  // Whether the one-time "still running in the tray" notification has been shown
  trayHintShown: false
};

function createSettings(filePath, defaults = DEFAULTS) {
  const values = { ...defaults };

  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const key of Object.keys(defaults)) {
      // Ignore unknown keys and values of the wrong type (hand-edited or corrupt files)
      if (typeof saved[key] === typeof defaults[key]) values[key] = saved[key];
    }
  } catch {
    // Missing or unreadable file: start from the defaults
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Write then rename so a crash or power cut cannot leave a half-written file
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(values, null, 2));
    fs.renameSync(tmp, filePath);
  }

  return {
    get: (key) => values[key],
    getAll: () => ({ ...values }),
    set(key, value) {
      if (!Object.hasOwn(defaults, key) || typeof value !== typeof defaults[key]) {
        throw new Error(`Invalid setting: ${key}`);
      }
      values[key] = value;
      save();
    }
  };
}

module.exports = { createSettings, DEFAULTS };
