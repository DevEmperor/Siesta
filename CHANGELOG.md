# Changelog

## 1.1.0 – 2026-10-26

First public release.

- **Timer per tab:** unload a tab after 5, 10, 15 or 30 minutes, 1 or 2 hours, or any
  custom time up to 24 hours without use – or never. The setting sticks to the tab and
  survives a browser restart.
- **Site rules:** one timer for every tab of a site, for example `teams.microsoft.com`.
- **Default timer** for all other tabs (off out of the box). A tab's own rule beats a
  site rule, which beats the default.
- **Live overview** in the toolbar popup: which tabs are loaded and which are unloaded,
  a countdown for each tab and the tab that unloads next. The moon icon wanes as a tab
  gets closer to being unloaded.
- **Unload by hand:** single tabs, the current tab (Siesta switches to your last tab
  first) or every inactive tab at once – also from the tab context menu, for one or
  several selected tabs.
- **Protection:** tabs playing audio, tabs sharing camera, microphone or screen and
  (with the default timer) pinned tabs stay loaded. When audio stops, the timer starts
  over.
- **Stats:** unloads of the last 7 days (automatic and by hand), the sites unloaded most
  often, recent unloads and how many unloaded tabs you reopened later.
- Pause switch; the toolbar icon shows the number of unloaded tabs, or "II" when paused.
- Light and dark theme, following Firefox.

Earlier versions (1.0.0 and 1.0.1) were internal, German-only builds; 1.0.1 removed an
estimated RAM figure because Firefox doesn't tell add-ons how much memory a tab uses.
