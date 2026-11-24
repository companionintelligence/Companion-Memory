import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { serviceLabels } from './runFormat';
import { ServiceBadges } from './ServiceBadges';

/**
 * An import should say what it WAS.
 *
 * The list had only the uploaded archive's filename, so a real import read as
 * "All Data Categories.zip" — which says nothing about it being Audible, Prime
 * Video and Kindle.
 */
describe('ServiceBadges', () => {
  it('names the services an import contained', () => {
    render(<ServiceBadges services={['Audible', 'Prime Video']} />);

    expect(screen.getByText('Audible')).toBeInTheDocument();
    expect(screen.getByText('Prime Video')).toBeInTheDocument();
  });

  it('counts the rest rather than listing seven of them', () => {
    // One Amazon export matched seven parsers. Seven badges under a filename is
    // not a summary.
    render(<ServiceBadges services={['Audible', 'Amazon', 'Prime Video', 'Kindle', 'Amazon Music']} />);

    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.queryByText('Kindle')).not.toBeInTheDocument();
  });

  it('keeps the ones that did not fit reachable', () => {
    render(<ServiceBadges services={['Audible', 'Amazon', 'Prime Video', 'Kindle', 'Amazon Music']} />);

    expect(screen.getByText('+2')).toHaveAttribute('title', 'Kindle, Amazon Music');
  });

  it('opens the counted remainder when the card has room for it', () => {
    // The opened run is the place to see every importer that ran; the summary
    // card in a four-column grid is not.
    const all = ['Audible', 'Amazon', 'Prime Video', 'Kindle', 'Amazon Music'];

    render(<ServiceBadges services={all} expandable />);
    fireEvent.click(screen.getByRole('button', { name: /\+2/ }));

    for (const service of all) {
      expect(screen.getByText(service)).toBeInTheDocument();
    }
  });

  it('can be collapsed again once expanded', () => {
    // Expanding to seven badges with no way back is the same trap as a details
    // view that opens and cannot close.
    render(<ServiceBadges services={['Audible', 'Amazon', 'Prime Video', 'Kindle']} expandable />);

    fireEvent.click(screen.getByRole('button', { name: /\+1/ }));
    expect(screen.getByText('Kindle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show fewer/i }));
    expect(screen.queryByText('Kindle')).not.toBeInTheDocument();
  });

  it('offers no button on the summary card, which cannot expand', () => {
    render(<ServiceBadges services={['Audible', 'Amazon', 'Prime Video', 'Kindle']} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('renders nothing for a run that has not parsed yet', () => {
    // An empty row of badges reads as "nothing found" rather than "not known
    // yet", and the run's status already says which.
    const { container } = render(<ServiceBadges services={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('serviceLabels', () => {
  const sources = [
    { name: 'audible', title: 'Audible' },
    { name: 'prime_video', title: 'Prime Video' },
  ];

  it('uses what the catalogue calls each source', () => {
    expect(serviceLabels(['audible', 'prime_video'], sources)).toEqual(['Audible', 'Prime Video']);
  });

  it('preserves the order it was given, which is the parse ranking', () => {
    expect(serviceLabels(['prime_video', 'audible'], sources)).toEqual(['Prime Video', 'Audible']);
  });

  it('shows a source the catalogue does not know rather than dropping it', () => {
    // A parser can outlive its catalogue entry, and a silently missing badge is
    // worse than an unpolished one.
    expect(serviceLabels(['kindle_reading'], sources)).toEqual(['kindle reading']);
  });

  it('names a service once, however many of its files the archive held', () => {
    // `import_runs.data_sources` records one entry per recognized FILE: a real
    // Google Takeout is 47 entries of which 30 are `google_my_activity`. Mapped
    // one-for-one that read "Google Voice, Google My Activity, Google My
    // Activity, +44" on the run card.
    expect(
      serviceLabels(
        ['google_voice', 'google_my_activity', 'google_my_activity', 'vcard', 'google_my_activity'],
        [
          { name: 'google_voice', title: 'Google Voice' },
          { name: 'google_my_activity', title: 'Google My Activity' },
        ],
      ),
    ).toEqual(['Google Voice', 'Google My Activity', 'vcard']);
  });

  it('keeps the first appearance, which is the parse ranking', () => {
    expect(serviceLabels(['audible', 'prime_video', 'audible'], sources)).toEqual(['Audible', 'Prime Video']);
  });

  it('collapses two importers the catalogue gives one title', () => {
    expect(
      serviceLabels(
        ['calendar', 'ics_calendar'],
        [
          { name: 'calendar', title: 'Calendar' },
          { name: 'ics_calendar', title: 'Calendar' },
        ],
      ),
    ).toEqual(['Calendar']);
  });
});
