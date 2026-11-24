export { AddEventModal } from './AddEventModal';
export { AddPersonModal } from './AddPersonModal';
// `AddPlaceModal` is deliberately NOT re-exported here. It mounts the Leaflet
// map (PlaceForm -> CurrentLocationField -> components/Map), and a barrel
// export is a static import: with it in this file, AddMenu's `lazy()` of the
// modal could not split it out (Vite: "also statically imported by
// index.ts, dynamic import will not move module into another chunk") and
// leaflet rode in the entry chunk for every page. Import it from
// './AddPlaceModal' directly, lazily where the page itself is not lazy.
export { EditPersonModal } from './EditPersonModal';
