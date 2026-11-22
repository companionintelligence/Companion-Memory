import { PYTHON_RUN_TOKEN_PURPOSE } from '../../python-functions/services/PythonFunctionTokenService';
import { RUN_TOKEN_PURPOSE } from '../runTokenAccess';

describe('runTokenAccess', () => {
  it('names the purpose PythonFunctionTokenService mints', () => {
    expect(RUN_TOKEN_PURPOSE).toBe(PYTHON_RUN_TOKEN_PURPOSE);
  });
});
