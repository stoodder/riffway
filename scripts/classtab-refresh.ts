/**
 * `npm run classtab:refresh` (T-025): conditional GET of the ClassTab zip into
 * `<dataDir>/classtab/`, then index (D2). Flags: `--force` ignores the once-per-day limit.
 * **Stub (T-010):** prints a notice and exits 0.
 */
import { NotImplementedError } from '@shared/errors';

const notice = new NotImplementedError('classtab:refresh', 'T-025');
console.log(`${notice.message}; nothing downloaded.`);
