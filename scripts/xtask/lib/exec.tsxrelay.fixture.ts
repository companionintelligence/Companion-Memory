/** Prints whether this process thinks it is running under the tsx CLI wrapper. Run only by exec.test.ts. */
import { underTsxRelay } from './exec';

process.stdout.write(`${JSON.stringify(underTsxRelay())}\n`);
