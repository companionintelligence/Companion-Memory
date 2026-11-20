import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ChoiceList,
  InfoTip,
  SegmentedControl,
  SettingsCard,
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from './kit';

describe('InfoTip', () => {
  it('keeps its text out of the page until asked, then shows it on click', async () => {
    render(<InfoTip label="About autonomy">Chat asks before it deletes anything.</InfoTip>);

    expect(screen.queryByText('Chat asks before it deletes anything.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'About autonomy' }));

    expect(await screen.findByText('Chat asks before it deletes anything.')).toBeInTheDocument();
  });

  it('moves focus into the popover when opened by click, so Tab reaches a link in it', async () => {
    render(
      <InfoTip label="About BlueBubbles">
        See <a href="https://bluebubbles.app">bluebubbles.app</a>.
      </InfoTip>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'About BlueBubbles' }));

    const popover = await screen.findByRole('dialog');
    expect(popover).toContainElement(screen.getByRole('link', { name: 'bluebubbles.app' }));
    await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true));
  });

  it('closes again on a second click', async () => {
    render(<InfoTip label="About port">The port the server listens on.</InfoTip>);
    const button = screen.getByRole('button', { name: 'About port' });

    fireEvent.click(button);
    expect(await screen.findByText('The port the server listens on.')).toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.queryByText('The port the server listens on.')).not.toBeInTheDocument();
  });
});

describe('SettingsSection', () => {
  it('puts the long explanation behind a (?) named after the section', async () => {
    render(
      <SettingsSection title="Privacy" description="What can leave this appliance." help="Search never leaves.">
        <p>body</p>
      </SettingsSection>,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Privacy' })).toBeInTheDocument();
    expect(screen.getByText('What can leave this appliance.')).toBeInTheDocument();
    expect(screen.queryByText('Search never leaves.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'About privacy' }));
    expect(await screen.findByText('Search never leaves.')).toBeInTheDocument();
  });
});

describe('SettingsRow', () => {
  it('labels its control and names the group it sits in', () => {
    render(
      <SettingsGroup title="Connection">
        <SettingsRow label="Port" htmlFor="port" hint="Usually 11434." control={<input id="port" />} />
      </SettingsGroup>,
    );

    expect(screen.getByRole('region', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.getByLabelText('Port')).toBeInTheDocument();
    expect(screen.getByText('Usually 11434.')).toBeInTheDocument();
  });

  it('renders nothing below the label for a false child', () => {
    const { container } = render(<SettingsRow label="Enabled">{false}</SettingsRow>);

    expect(container.querySelector('.mt-3')).toBeNull();
  });
});

describe('SettingsCard', () => {
  it('draws nothing when every row is hidden', () => {
    const { container } = render(
      <SettingsCard>
        {false}
        {null}
      </SettingsCard>,
    );

    expect(container.querySelector('[data-slot="settings-card"]')).toBeNull();
  });
});

describe('SettingsStatus', () => {
  it('reports errors as alerts and keeps the message as the element’s own text', () => {
    render(<SettingsStatus tone="error">Connection refused</SettingsStatus>);

    expect(screen.getByRole('alert')).toBe(screen.getByText('Connection refused'));
  });

  it('reports other outcomes as status', () => {
    render(
      <SettingsFooter status={<SettingsStatus tone="success">Saved</SettingsStatus>}>
        <button type="button">Save</button>
      </SettingsFooter>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });
});

describe('SegmentedControl and ChoiceList', () => {
  it('expose one checked radio and report the new choice', () => {
    const onChange = vi.fn();

    render(
      <SegmentedControl
        label="Theme"
        value="dark"
        onChange={onChange}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />,
    );

    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('gives each choice its hint as part of the option', () => {
    const onChange = vi.fn();

    render(
      <ChoiceList
        label="Autonomy"
        value="balanced"
        onChange={onChange}
        options={[
          { value: 'cautious', label: 'Cautious', hint: 'Asks first.' },
          { value: 'balanced', label: 'Balanced', hint: 'Asks for the big things.' },
        ]}
      />,
    );

    expect(screen.getByRole('radio', { name: /Balanced/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /Cautious/ }));
    expect(onChange).toHaveBeenCalledWith('cautious');
  });

  it('keep one tab stop and move the choice with the arrow keys, skipping disabled options', () => {
    const onChange = vi.fn();

    render(
      <SegmentedControl
        label="Location tracking"
        value="off"
        onChange={onChange}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'always', label: 'Always', disabled: true },
          { value: 'when_in_use', label: 'While using' },
        ]}
      />,
    );

    const off = screen.getByRole('radio', { name: 'Off' });
    const whileUsing = screen.getByRole('radio', { name: 'While using' });

    expect(off).toHaveAttribute('tabindex', '0');
    expect(whileUsing).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(off, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('when_in_use');
    expect(whileUsing).toHaveFocus();

    fireEvent.keyDown(whileUsing, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('off');

    fireEvent.keyDown(off, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('when_in_use');
  });
});
