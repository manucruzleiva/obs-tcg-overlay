/**
 * The "Fonts" tab of the design editor: a font for each group of text of the overlay (names, numbers, labels, the titles and subtitles of the
 * announcements, small text), besides the main font. Each group can have a font file of its own (it goes up the moment it is chosen, like the
 * pictures) and/or a list of fonts to use, a CSS font-family such as "Impact, Arial Black, sans-serif", for fonts that are installed on the
 * computer that shows the overlay. What a group does not have is the main font's. The overlay in the editor follows as the list is typed.
 */
import { h, icon } from './dom.js';

const THEME = window.OTO_THEME;
const RULES = window.OTO_THEME_RULES;

export class FontsPanel {
  // `fileOf(role)` is the font file a group has (its name), or null; `upload(role)` asks for one and puts it on the group; `removeFile(role)` takes it off
  constructor({ model, fileOf, upload, removeFile }) {
    this.model = model;
    this.fileOf = fileOf;
    this.upload = upload;
    this.removeFile = removeFile;
    this.rows = new Map();
    this.build();
    this.refresh();
  }

  build() {
    this.list = h('div', { class: 'font-list' }, THEME.FONT_ROLES.map((role) => this.row(role)));
    this.element = h('div', { class: 'fonts-panel' },
      h('p', { class: 'settings-note' }, 'Each kind of text of the overlay can have a font of its own: a font file (WOFF2, WOFF, TTF or OTF, up to 4.5 MB), and/or the names of fonts that are installed on the computer that shows the overlay, separated by commas (the first that exists is used). What has none uses the main font. The overlay follows as you type.'),
      this.list);
  }

  row(role) {
    const input = h('input', {
      type: 'text', maxlength: THEME.FONT_FAMILY_MAX, placeholder: role.key === 'display' ? 'Fonts to use, for example Impact, Arial Black, sans-serif' : 'The main font', 'aria-label': `Fonts to use for ${role.label}`,
      dataset: { role: role.key }
    });
    const complaint = h('p', { class: 'prompt-complaint', role: 'alert', hidden: true });
    input.addEventListener('input', () => {
      // a list of fonts that cannot be used is said so, and the design keeps the last one that could
      try {
        RULES.sanitizeFontFamilies({ [role.key]: input.value }, { strict: true });
        complaint.hidden = true;
        input.removeAttribute('aria-invalid');
      } catch (error) {
        complaint.textContent = error.message;
        complaint.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      this.model.setFontFamily(role.key, input.value, { source: 'fields' });
    });
    const file = h('span', { class: 'font-file' });
    const uploadButton = h('button', { class: 'btn tiny', type: 'button', dataset: { upload: role.key }, onclick: () => this.upload(role.key) });
    const removeButton = h('button', { class: 'btn tiny', type: 'button', dataset: { remove: role.key }, onclick: () => this.removeFile(role.key) }, icon('trash', 14), 'Remove the file');
    const node = h('section', { class: 'font-row', dataset: { role: role.key } },
      h('div', { class: 'font-info' }, h('strong', {}, role.label), h('small', {}, role.help)),
      input, complaint,
      h('div', { class: 'button-row' }, uploadButton, removeButton, file));
    this.rows.set(role.key, { input, file, uploadButton, removeButton, complaint });
    return node;
  }

  // Put what the draft and the design's files say into the rows (a box being typed in is left alone)
  refresh() {
    for (const role of THEME.FONT_ROLES) {
      const row = this.rows.get(role.key);
      const wanted = (this.model.draft.fontFamilies || {})[role.key] || '';
      if (document.activeElement !== row.input && row.input.getAttribute('aria-invalid') !== 'true') row.input.value = wanted;
      const name = this.fileOf(role.key);
      row.file.textContent = name || '';
      row.uploadButton.replaceChildren(icon('upload', 14), name ? 'Replace the font file' : 'Upload a font file');
      row.removeButton.hidden = !name;
    }
  }
}
