const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(.\d+)?Z)?$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findMaxDate(obj: any): Date | null {
  let maxDate: Date | null = null;
  const visited = new Set();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function traverse(current: any) {
    if (!current || typeof current !== 'object') {
      if (typeof current === 'string' && ISO_DATE_REGEX.test(current)) {
        const d = new Date(current);
        if (!isNaN(d.getTime())) {
          if (!maxDate || d > maxDate) {
            maxDate = d;
          }
        }
      }

      return;
    }

    if (visited.has(current)) {
      return;
    }

    visited.add(current);

    if (current instanceof Date) {
      if (!isNaN(current.getTime())) {
        if (!maxDate || current > maxDate) {
          maxDate = current;
        }
      }

      return;
    }

    for (const key in current) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        traverse(current[key]);
      }
    }
  }

  traverse(obj);

  return maxDate;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function shiftDatesInObject(obj: any, deltaMs: number): void {
  const visited = new Set();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function traverse(current: any) {
    if (!current || typeof current !== 'object') {
      return;
    }

    if (visited.has(current)) {
      return;
    }

    visited.add(current);

    if (current instanceof Date) {
      return;
    }

    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        continue;
      }

      const val = current[key];

      if (val instanceof Date) {
        current[key] = new Date(val.getTime() + deltaMs);
      } else if (typeof val === 'string' && ISO_DATE_REGEX.test(val)) {
        const d = new Date(val);
        if (!isNaN(d.getTime())) {
          const newD = new Date(d.getTime() + deltaMs);
          if (val.length === 10) {
            current[key] = newD.toISOString().slice(0, 10);
          } else {
            current[key] = newD.toISOString();
          }
        }
      } else if (typeof val === 'object' && val !== null) {
        traverse(val);
      }
    }
  }

  traverse(obj);
}
