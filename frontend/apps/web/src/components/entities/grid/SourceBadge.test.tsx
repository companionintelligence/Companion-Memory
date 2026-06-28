import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SourceBadge } from './SourceBadge';

describe('SourceBadge', () => {
  it('maps known source systems to friendly labels', () => {
    render(<SourceBadge source="google_voice" />);
    expect(screen.getByText('Voice')).toBeInTheDocument();
  });

  it('title-cases unknown sources', () => {
    render(<SourceBadge source="github_api" />);
    expect(screen.getByText('Github Api')).toBeInTheDocument();
  });

  it('shows the fallback when there is no source', () => {
    render(<SourceBadge fallback="Event" />);
    expect(screen.getByText('Event')).toBeInTheDocument();
  });

  it('renders nothing with neither source nor fallback', () => {
    const { container } = render(<SourceBadge />);
    expect(container).toBeEmptyDOMElement();
  });
});
