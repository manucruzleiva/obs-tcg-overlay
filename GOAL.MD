# Project Goal — OTO: OBS TCG Overlay

## Mission
Give Pokémon TCG streamers, stores, and event organizers a clear, customizable live match overlay and a practical control panel for presenting the state and excitement of a match to viewers.

## User Value
The audience should be able to follow prizes, Active and Benched Pokémon, HP, tools, energy, Stadium, score, and announcements without losing sight of the match. Producers should be able to update the overlay from a laptop, tablet, or phone, with multiple collaborators able to operate simultaneously without overwriting one another's changes.

## Product Scope
Deliver a browser-based overlay suitable for OBS, a responsive producer control interface, synchronized match state, concurrent producer access, password protection, customizable visual themes and sounds, and an offline card library. Support the practical workflow of running a complete match from setup through final score while keeping the overlay readable at common streaming resolutions.

## Quality Principles
- Keep the viewer-facing overlay clean and legible.
- Make state changes predictable and prevent concurrent users from silently overwriting one another.
- Protect control access and provide clear session and connection status.
- Keep setup approachable for nontechnical producers.
- Make themes and sounds customizable without requiring source-code edits.
- Work reliably when external card data or internet access is unavailable where offline support is intended.
- Clearly communicate that the project is unofficial and independent.

## Success Criteria
- A full match can be operated through the control panel and reflected accurately in OBS.
- Multiple producers can collaborate without inconsistent match state.
- Overlay layout, assets, and sounds can be customized by non-developers.
- Offline card data remains usable for core match operations.
- Installation and recovery from common mistakes are documented and straightforward.
- Known limitations are explicit and regression-tested.

## Boundaries
OTO is a presentation and match-state tool, not an official Pokémon product or an automated referee. Producers remain responsible for the accuracy of the entered match state and compliance with event rules.