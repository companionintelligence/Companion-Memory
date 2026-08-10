import { input } from '@inquirer/prompts';

import { SignupCodeService } from '@ci/domains/auth';

import { createAdminTestingModule } from './support/admin-testing-module';

(async function () {
  const module = await createAdminTestingModule().compile();

  await module.init();

  const signupCodeService = module.get(SignupCodeService);

  const numCodes = await input({
    message: 'Number of signup codes to generate:',
    validate: (value) =>
      (value.trim() !== '' && parseInt(value) > 0) ||
      'Number of codes is required and must be an integer > 0',
  });

  let exitCode = 0;
  const codes: string[] = [];

  try {
    for (let i = 0; i < parseInt(numCodes); i++) {
      const signupCode = await signupCodeService.create();

      codes.push(signupCode.signup_code);
    }

    console.log(`\nSuccessfully created codes:\n\n${codes.join('\n')}\n`);
  } catch (err) {
    console.error('\nFailed to create some codes:', (err as Error).message);

    if (codes.length > 0) {
      console.log('\nBut did create these codes', codes);
    }

    exitCode = 1;
  }

  await module.close();

  process.exit(exitCode);
})();
