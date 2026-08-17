import {
  ApproveEditSelector,
  KeepDiscardSelector,
  PickAFaceSelector,
  SegmentedTruthSelector,
  YesNoNotSureSelector,
  YesNoSelector,
} from './BinarySelectors';
import {
  ABSelector,
  ChecklistSelector,
  FeelingGridSelector,
  PersonFindSelector,
  RadioListSelector,
  TagCloudSelector,
} from './ChoiceSelectors';
import {
  AcceptEditsSelector,
  AcceptSlotSelector,
  ConnectionTypeSelector,
  CropFocusSelector,
  MediaMomentSelector,
  PickADaySelector,
  PickImagesSelector,
  SourceOfTruthSelector,
  TapHubSelector,
} from './MediaGraphDataSelectors';
import {
  GuidedWriteSelector,
  OneLineSelector,
  ParagraphSelector,
  SentenceStemSelector,
} from './OpenSelectors';
import {
  AttendeesSelector,
  DropPinSelector,
  HomeWorkOtherSelector,
  PersonPickerSelector,
  RelationshipSelector,
  VenueListSelector,
  WhatDidYouDoHereSelector,
} from './PeoplePlaceSelectors';
import { DragRankSelector, IntensitySelector, PrivacySliderSelector } from './ScaleSelectors';
import {
  ActivityScrubSelector,
  DayChipsSelector,
  DeepWorkSelector,
  PresetScopeSelector,
  RecurrenceSelector,
  TripWindowSelector,
} from './TimeSelectors';
import type { SelectorSpec, SelectorValue } from './types';

interface Props {
  spec: SelectorSpec;
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
}

export function SelectorRenderer({ spec, value, onChange }: Props) {
  const common = { options: spec.options, value, onChange };

  switch (spec.type) {
    case 'yes_no':
      return <YesNoSelector {...common} />;
    case 'yes_no_not_sure':
      return <YesNoNotSureSelector {...common} />;
    case 'keep_discard':
      return <KeepDiscardSelector {...common} />;
    case 'approve_edit':
      return <ApproveEditSelector {...common} />;
    case 'segmented_truth':
      return <SegmentedTruthSelector {...common} />;
    case 'pick_a_face':
      return <PickAFaceSelector {...common} />;
    case 'radio_list':
      return <RadioListSelector {...common} />;
    case 'checklist':
      return <ChecklistSelector {...common} />;
    case 'tag_cloud':
      return <TagCloudSelector {...common} />;
    case 'a_b':
      return <ABSelector {...common} />;
    case 'feeling_grid':
      return <FeelingGridSelector {...common} />;
    case 'person_find':
      return <PersonFindSelector {...common} />;
    case 'one_line':
      return <OneLineSelector value={value} onChange={onChange} />;
    case 'paragraph':
      return <ParagraphSelector value={value} onChange={onChange} />;
    case 'guided_write':
      return <GuidedWriteSelector value={value} onChange={onChange} scaffold={spec.scaffold} />;
    case 'sentence_stem':
      return <SentenceStemSelector value={value} onChange={onChange} stem={spec.stem} />;
    case 'intensity_1_5':
      return <IntensitySelector {...common} min={spec.min} max={spec.max} />;
    case 'privacy_slider':
      return <PrivacySliderSelector {...common} />;
    case 'drag_rank':
      return <DragRankSelector {...common} />;
    case 'day_chips':
      return <DayChipsSelector {...common} />;
    case 'trip_window':
      return <TripWindowSelector {...common} min={spec.min} max={spec.max} />;
    case 'preset_scope':
      return <PresetScopeSelector {...common} />;
    case 'recurrence':
      return <RecurrenceSelector {...common} />;
    case 'activity_scrub':
      return <ActivityScrubSelector {...common} min={spec.min} max={spec.max} />;
    case 'deep_work':
      return <DeepWorkSelector {...common} />;
    case 'person_picker':
      return <PersonPickerSelector {...common} />;
    case 'attendees':
      return <AttendeesSelector {...common} />;
    case 'relationship':
      return <RelationshipSelector {...common} />;
    case 'drop_pin':
      return <DropPinSelector {...common} center={spec.center} />;
    case 'venue_list':
      return <VenueListSelector {...common} />;
    case 'home_work_other':
      return <HomeWorkOtherSelector {...common} />;
    case 'what_did_you_do_here':
      return <WhatDidYouDoHereSelector {...common} />;
    case 'pick_images':
      return <PickImagesSelector {...common} images={spec.images} />;
    case 'crop_focus':
      return <CropFocusSelector {...common} images={spec.images} />;
    case 'media_moment':
      return <MediaMomentSelector {...common} min={spec.min} max={spec.max} />;
    case 'tap_hub':
      return <TapHubSelector {...common} nodes={spec.nodes} />;
    case 'connection_type':
      return <ConnectionTypeSelector {...common} />;
    case 'pick_a_day':
      return <PickADaySelector {...common} />;
    case 'source_of_truth':
      return <SourceOfTruthSelector {...common} />;
    case 'accept_slot':
      return <AcceptSlotSelector {...common} />;
    case 'accept_edits':
      return <AcceptEditsSelector {...common} />;
    default:
      return null;
  }
}
