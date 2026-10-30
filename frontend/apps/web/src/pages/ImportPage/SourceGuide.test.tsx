import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SourceGuide } from './SourceGuide';
import type { ImportSourceGuide } from './useImportApi';

/**
 * The card that answers "how do I actually get my data out of this
 * service" — the alt path (a second route some services offer, like a
 * settings-page request instead of the main export flow), the caveats and
 * what-this-brings-in lists, and the logo, which has to give up gracefully
 * when the brand asset 404s rather than showing a broken-image icon forever.
 */

function guide(overrides: Partial<ImportSourceGuide> = {}): ImportSourceGuide {
  return {
    title: 'Spotify',
    blurb: 'Your streaming history.',
    ecosystem: 'music',
    category: 'audio',
    wait: 'days',
    steps: ['Ask for the export.', 'Wait for the email.'],
    ...overrides,
  };
}

describe('SourceGuide logo', () => {
  it('shows the logo when one is supplied', () => {
    render(<SourceGuide guide={guide()} logo="/import-logos/spotify.svg" />);

    expect(document.querySelector('img[src="/import-logos/spotify.svg"]')).not.toBeNull();
  });

  it('renders no image at all when no logo is supplied', () => {
    render(<SourceGuide guide={guide()} />);

    expect(document.querySelector('img')).toBeNull();
  });

  it('drops the logo for good once it fails to load, rather than a broken-image icon', () => {
    render(<SourceGuide guide={guide()} logo="/import-logos/broken.svg" />);

    const img = document.querySelector('img[src="/import-logos/broken.svg"]');

    expect(img).not.toBeNull();

    fireEvent.error(img!);

    expect(document.querySelector('img')).toBeNull();
  });
});

describe('SourceGuide alt path', () => {
  it('renders the alternate steps under their own heading, with their own CTA', () => {
    render(
      <SourceGuide
        guide={guide({
          altPath: {
            title: 'No account? Request it by mail',
            url: 'https://spotify.com/privacy/request',
            steps: ['Fill out the form.', 'Wait for a reply.'],
          },
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No account? Request it by mail' })).toBeInTheDocument();
    expect(screen.getByText('Fill out the form.')).toBeInTheDocument();

    const altCta = screen.getByRole('link', { name: /open the spotify export page/i });

    expect(altCta).toHaveAttribute('href', 'https://spotify.com/privacy/request');
  });

  it('renders a link inside a step as a visible link that opens in a new tab', () => {
    render(
      <SourceGuide
        guide={guide({
          altPath: {
            title: 'Recurring sync',
            steps: ['Create a connection to [Dropbox](/providers/01a10dc2-7dc5-7d4c-b3ab-7d3caaf7ebd3).'],
          },
        })}
      />,
    );

    const link = screen.getByRole('link', { name: 'Dropbox' });

    expect(link).toHaveAttribute('href', '/providers/01a10dc2-7dc5-7d4c-b3ab-7d3caaf7ebd3');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // Styled by the list it sits in, not by the markdown renderer.
    expect(link.closest('ol')?.className).toMatch(/\[&_a\]:text-blue-600/);
  });

  it('renders alt-path steps with no CTA when the alt path has no url', () => {
    render(
      <SourceGuide
        guide={guide({
          altPath: { title: 'Ask support directly', steps: ['Reach out through the help center.'] },
        })}
      />,
    );

    expect(screen.getByText('Reach out through the help center.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /export page/i })).not.toBeInTheDocument();
  });

  it('renders no alt-path section at all when the guide has none', () => {
    render(<SourceGuide guide={guide()} />);

    expect(screen.queryByRole('heading', { name: /request/i })).not.toBeInTheDocument();
  });
});

describe('SourceGuide whatImported and caveats', () => {
  it('lists what the import brings in', () => {
    render(<SourceGuide guide={guide({ whatImported: ['Listening history', 'Saved playlists'] })} />);

    expect(screen.getByRole('heading', { name: /what this brings in/i })).toBeInTheDocument();
    expect(screen.getByText('Listening history')).toBeInTheDocument();
    expect(screen.getByText('Saved playlists')).toBeInTheDocument();
  });

  it('omits the whatImported section when the guide has nothing to list', () => {
    render(<SourceGuide guide={guide()} />);

    expect(screen.queryByRole('heading', { name: /what this brings in/i })).not.toBeInTheDocument();
  });

  it('flags caveats under a warning heading', () => {
    render(<SourceGuide guide={guide({ caveats: ['The extended history arrives weeks later.'] })} />);

    expect(screen.getByRole('heading', { name: /worth knowing first/i })).toBeInTheDocument();
    expect(screen.getByText(/extended history arrives weeks later/i)).toBeInTheDocument();
  });

  it('omits the caveats section when the guide has none', () => {
    render(<SourceGuide guide={guide()} />);

    expect(screen.queryByRole('heading', { name: /worth knowing first/i })).not.toBeInTheDocument();
  });

  it('renders both sections together without one crowding out the other', () => {
    render(
      <SourceGuide
        guide={guide({
          whatImported: ['Listening history'],
          caveats: ['Can take up to 30 days.'],
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: /what this brings in/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /worth knowing first/i })).toBeInTheDocument();
  });
});
