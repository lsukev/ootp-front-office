import { buildFixture } from './fixture';

// The server modules open their database at import time, so the fixture has to
// exist and OOTP_FO_DATA_DIR has to point at it before any of them load.
process.env.OOTP_FO_DATA_DIR = buildFixture();
process.env.OOTP_FO_APP_ROOT = process.cwd();
