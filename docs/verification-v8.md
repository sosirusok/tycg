# v8 verification

Date: 2026-09-30

- TypeScript compilation and production build pass.
- Independent review confirmed the legacy full-set normalization adds only the old skeleton skin, never the new first option (유루미).
- Existing detail fields and legacy selections survive editing. Legacy selections already present on a record remain removable without adding them to the new preferred checkbox list.
- Browser QA used only the internal preview and explicitly labeled local fixtures. No example transactions were added to production.
- Desktop: all eight requested checkboxes render. 유루미 OR 뱀파이어 정동석 returns the expected two local records; removing 유루미 narrows to the expected one record.
- Mobile 390px iframe: body client width and scroll width both 375px (remaining width is the scrollbar). No horizontal overflow.
- Mobile: skin and ladder selections survive switching tabs. Closing without applying leaves the listing query unchanged.
- Screenshots reviewed for the header, search, icon navigation, listing rows, skin drawer and mobile bottom controls.
- Form copy was reviewed in source: neutral title placeholder, account skin details in description, category-specific service description, no other-skins input.
- Authentication, chat and payments were not newly tested in this visual revision. The product does not provide a payment service.
- Local fixtures and the temporary mobile inspection page were removed before packaging.
