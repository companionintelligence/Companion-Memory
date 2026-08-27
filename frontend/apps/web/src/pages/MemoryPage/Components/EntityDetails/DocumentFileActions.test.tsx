import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DocumentFileActions, formatBytes, isHttpUrl } from './DocumentFileActions';

describe('DocumentFileActions', () => {
  it('opens the href in a new tab', () => {
    render(<DocumentFileActions href="/static/file.pdf" filename="file.pdf" />);

    const open = screen.getByRole('link', { name: 'Open' });
    expect(open).toHaveAttribute('href', '/static/file.pdf');
    expect(open).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('adds Download when asked', () => {
    render(<DocumentFileActions href="/static/file.pdf" filename="file.pdf" download />);

    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'file.pdf');
  });
});

describe('formatBytes / isHttpUrl', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(102400)).toBe('100.0 KB');
  });

  it('recognises http origins', () => {
    expect(isHttpUrl('https://mail.google.com/x')).toBe(true);
    expect(isHttpUrl('/companion/key')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});
