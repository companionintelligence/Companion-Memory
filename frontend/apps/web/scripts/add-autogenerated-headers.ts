import fs from 'fs';
import path from 'path';

const HEADER = `/* ------------------------------------------------------- */
/*  THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)  */
/* ------------------------------------------------------- */

/* eslint-disable */
`;

function addHeaderToFiles(filePaths: string[]) {
  if (filePaths.length === 0) {
    return;
  }

  filePaths.forEach((filePath) => {
    try {
      const fullPath = path.resolve(process.cwd(), filePath);

      if (!fs.existsSync(fullPath)) {
        return;
      }

      let content = fs.readFileSync(fullPath, 'utf-8');

      content = content.replace(/\/\* eslint-disable \*\/\n?/g, '');
      content = content.replace(
        /\/\* ------------------------------------------------------- \*\/[\s\S]*?\/\* ------------------------------------------------------- \*\/\n?/g,
        '',
      );

      const newContent = HEADER + content.trimStart();

      fs.writeFileSync(fullPath, newContent, 'utf-8');
    } catch (error) {
      console.error(`Error processing ${filePath}:`, error);
    }
  });
}

const files = process.argv.slice(2);

addHeaderToFiles(files);
