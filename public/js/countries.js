/**
 * Countries and their flags: turns what is typed as a trainer's nationality into a flag emoji, for the overlay (when it is set to
 * show flags) and the control panel. Loaded in the browser as OTO_COUNTRIES and by the tests (via require).
 *
 * It understands the two-letter ISO codes (CL), the three-letter ISO codes (CHL), a few of the codes sports use that are not the ISO
 * ones (GER, SUI, CHI for Chile...), the names of the countries in English (Chile, South Korea), England, Scotland and Wales, and a
 * flag that was pasted as it is. Anything else has no flag: ask flagOf for it and get an empty string.
 *
 * The two-letter and three-letter codes and the names are the ISO 3166-1 list.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_COUNTRIES = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // three-letter code : two-letter code
  const ALPHA3 = "AFG:AF ALA:AX ALB:AL DZA:DZ ASM:AS AND:AD AGO:AO AIA:AI ATA:AQ ATG:AG ARG:AR ARM:AM ABW:AW AUS:AU AUT:AT AZE:AZ BHS:BS BHR:BH BGD:BD BRB:BB BLR:BY BEL:BE BLZ:BZ BEN:BJ BMU:BM BTN:BT BOL:BO BES:BQ BIH:BA BWA:BW BVT:BV BRA:BR IOT:IO BRN:BN BGR:BG BFA:BF BDI:BI CPV:CV KHM:KH CMR:CM CAN:CA CYM:KY CAF:CF TCD:TD CHL:CL CHN:CN CXR:CX CCK:CC COL:CO COM:KM COG:CG COD:CD COK:CK CRI:CR CIV:CI HRV:HR CUB:CU CUW:CW CYP:CY CZE:CZ DNK:DK DJI:DJ DMA:DM DOM:DO ECU:EC EGY:EG SLV:SV GNQ:GQ ERI:ER EST:EE ETH:ET FLK:FK FRO:FO FJI:FJ FIN:FI FRA:FR GUF:GF PYF:PF ATF:TF GAB:GA GMB:GM GEO:GE DEU:DE GHA:GH GIB:GI GRC:GR GRL:GL GRD:GD GLP:GP GUM:GU GTM:GT GGY:GG GIN:GN GNB:GW GUY:GY HTI:HT HMD:HM VAT:VA HND:HN HKG:HK HUN:HU ISL:IS IND:IN IDN:ID IRN:IR IRQ:IQ IRL:IE IMN:IM ISR:IL ITA:IT JAM:JM JPN:JP JEY:JE JOR:JO KAZ:KZ KEN:KE KIR:KI PRK:KP KOR:KR KWT:KW KGZ:KG LAO:LA LVA:LV LBN:LB LSO:LS LBR:LR LBY:LY LIE:LI LTU:LT LUX:LU MAC:MO MKD:MK MDG:MG MWI:MW MYS:MY MDV:MV MLI:ML MLT:MT MHL:MH MTQ:MQ MRT:MR MUS:MU MYT:YT MEX:MX FSM:FM MDA:MD MCO:MC MNG:MN MNE:ME MSR:MS MAR:MA MOZ:MZ MMR:MM NAM:NA NRU:NR NPL:NP NLD:NL NCL:NC NZL:NZ NIC:NI NER:NE NGA:NG NIU:NU NFK:NF MNP:MP NOR:NO OMN:OM PAK:PK PLW:PW PSE:PS PAN:PA PNG:PG PRY:PY PER:PE PHL:PH PCN:PN POL:PL PRT:PT PRI:PR QAT:QA REU:RE ROU:RO RUS:RU RWA:RW BLM:BL SHN:SH KNA:KN LCA:LC MAF:MF SPM:PM VCT:VC WSM:WS SMR:SM STP:ST SAU:SA SEN:SN SRB:RS SYC:SC SLE:SL SGP:SG SXM:SX SVK:SK SVN:SI SLB:SB SOM:SO ZAF:ZA SGS:GS SSD:SS ESP:ES LKA:LK SDN:SD SUR:SR SJM:SJ SWZ:SZ SWE:SE CHE:CH SYR:SY TWN:TW TJK:TJ TZA:TZ THA:TH TLS:TL TGO:TG TKL:TK TON:TO TTO:TT TUN:TN TUR:TR TKM:TM TCA:TC TUV:TV UGA:UG UKR:UA ARE:AE GBR:GB USA:US UMI:UM URY:UY UZB:UZ VUT:VU VEN:VE VNM:VN VGB:VG VIR:VI WLF:WF ESH:EH YEM:YE ZMB:ZM ZWE:ZW";
  // two-letter code = name (as ISO writes it)
  const NAMES = "AF=Afghanistan|AX=Åland Islands|AL=Albania|DZ=Algeria|AS=American Samoa|AD=Andorra|AO=Angola|AI=Anguilla|AQ=Antarctica|AG=Antigua and Barbuda|AR=Argentina|AM=Armenia|AW=Aruba|AU=Australia|AT=Austria|AZ=Azerbaijan|BS=Bahamas|BH=Bahrain|BD=Bangladesh|BB=Barbados|BY=Belarus|BE=Belgium|BZ=Belize|BJ=Benin|BM=Bermuda|BT=Bhutan|BO=Bolivia|BQ=Bonaire, Sint Eustatius and Saba|BA=Bosnia and Herzegovina|BW=Botswana|BV=Bouvet Island|BR=Brazil|IO=British Indian Ocean Territory|BN=Brunei Darussalam|BG=Bulgaria|BF=Burkina Faso|BI=Burundi|CV=Cabo Verde|KH=Cambodia|CM=Cameroon|CA=Canada|KY=Cayman Islands|CF=Central African Republic|TD=Chad|CL=Chile|CN=China|CX=Christmas Island|CC=Cocos Islands|CO=Colombia|KM=Comoros|CG=Congo|CD=Congo|CK=Cook Islands|CR=Costa Rica|CI=Côte d'Ivoire|HR=Croatia|CU=Cuba|CW=Curaçao|CY=Cyprus|CZ=Czech Republic|DK=Denmark|DJ=Djibouti|DM=Dominica|DO=Dominican Republic|EC=Ecuador|EG=Egypt|SV=El Salvador|GQ=Equatorial Guinea|ER=Eritrea|EE=Estonia|ET=Ethiopia|FK=Falkland Islands|FO=Faroe Islands|FJ=Fiji|FI=Finland|FR=France|GF=French Guiana|PF=French Polynesia|TF=French Southern Territories|GA=Gabon|GM=Gambia|GE=Georgia|DE=Germany|GH=Ghana|GI=Gibraltar|GR=Greece|GL=Greenland|GD=Grenada|GP=Guadeloupe|GU=Guam|GT=Guatemala|GG=Guernsey|GN=Guinea|GW=Guinea-Bissau|GY=Guyana|HT=Haiti|HM=Heard Island and McDonald Islands|VA=Holy See|HN=Honduras|HK=Hong Kong|HU=Hungary|IS=Iceland|IN=India|ID=Indonesia|IR=Islamic Republic of Iran|IQ=Iraq|IE=Ireland|IM=Isle of Man|IL=Israel|IT=Italy|JM=Jamaica|JP=Japan|JE=Jersey|JO=Jordan|KZ=Kazakhstan|KE=Kenya|KI=Kiribati|KP=Democratic People's Republic of Korea|KR=Republic of Korea|KW=Kuwait|KG=Kyrgyzstan|LA=Lao People's Democratic Republic|LV=Latvia|LB=Lebanon|LS=Lesotho|LR=Liberia|LY=Libya|LI=Liechtenstein|LT=Lithuania|LU=Luxembourg|MO=Macao|MK=Macedonia|MG=Madagascar|MW=Malawi|MY=Malaysia|MV=Maldives|ML=Mali|MT=Malta|MH=Marshall Islands|MQ=Martinique|MR=Mauritania|MU=Mauritius|YT=Mayotte|MX=Mexico|FM=Federated States of Micronesia|MD=Republic of Moldova|MC=Monaco|MN=Mongolia|ME=Montenegro|MS=Montserrat|MA=Morocco|MZ=Mozambique|MM=Myanmar|NA=Namibia|NR=Nauru|NP=Nepal|NL=Netherlands|NC=New Caledonia|NZ=New Zealand|NI=Nicaragua|NE=Niger|NG=Nigeria|NU=Niue|NF=Norfolk Island|MP=Northern Mariana Islands|NO=Norway|OM=Oman|PK=Pakistan|PW=Palau|PS=State of Palestine|PA=Panama|PG=Papua New Guinea|PY=Paraguay|PE=Peru|PH=Philippines|PN=Pitcairn|PL=Poland|PT=Portugal|PR=Puerto Rico|QA=Qatar|RE=Réunion|RO=Romania|RU=Russian Federation|RW=Rwanda|BL=Saint Barthélemy|SH=Saint Helena, Ascension and Tristan da Cunha|KN=Saint Kitts and Nevis|LC=Saint Lucia|MF=Saint Martin|PM=Saint Pierre and Miquelon|VC=Saint Vincent and the Grenadines|WS=Samoa|SM=San Marino|ST=Sao Tome and Principe|SA=Saudi Arabia|SN=Senegal|RS=Serbia|SC=Seychelles|SL=Sierra Leone|SG=Singapore|SX=Sint Maarten|SK=Slovakia|SI=Slovenia|SB=Solomon Islands|SO=Somalia|ZA=South Africa|GS=South Georgia and the South Sandwich Islands|SS=South Sudan|ES=Spain|LK=Sri Lanka|SD=Sudan|SR=Suriname|SJ=Svalbard and Jan Mayen|SZ=Swaziland|SE=Sweden|CH=Switzerland|SY=Syrian Arab Republic|TW=Taiwan, Province of China|TJ=Tajikistan|TZ=United Republic of Tanzania|TH=Thailand|TL=Timor-Leste|TG=Togo|TK=Tokelau|TO=Tonga|TT=Trinidad and Tobago|TN=Tunisia|TR=Turkey|TM=Turkmenistan|TC=Turks and Caicos Islands|TV=Tuvalu|UG=Uganda|UA=Ukraine|AE=United Arab Emirates|GB=United Kingdom of Great Britain and Northern Ireland|US=United States of America|UM=United States Minor Outlying Islands|UY=Uruguay|UZ=Uzbekistan|VU=Vanuatu|VE=Venezuela (Bolivarian Republic of)|VN=Viet Nam|VG=Virgin Islands|VI=Virgin Islands of the United States|WF=Wallis and Futuna|EH=Western Sahara|YE=Yemen|ZM=Zambia|ZW=Zimbabwe";

  // The codes people write that are not the ISO ones (the Olympic ones, mostly), and short forms of names
  const CODES = {
    UK: 'GB', GER: 'DE', SUI: 'CH', NED: 'NL', POR: 'PT', DEN: 'DK', GRE: 'GR', CRO: 'HR', BUL: 'BG', RSA: 'ZA', URU: 'UY',
    PAR: 'PY', CHI: 'CL', ESA: 'SV', GUA: 'GT', HON: 'HN', CRC: 'CR', NCA: 'NI', PUR: 'PR', TPE: 'TW', UAE: 'AE', KSA: 'SA', INA: 'ID', PHI: 'PH',
    SIN: 'SG', MAS: 'MY', VIE: 'VN', LAT: 'LV', SLO: 'SI'
  };
  const SHORT_NAMES = {
    'UNITED STATES': 'US', AMERICA: 'US', 'UNITED STATES OF AMERICA': 'US', 'GREAT BRITAIN': 'GB', BRITAIN: 'GB', 'UNITED KINGDOM': 'GB', RUSSIA: 'RU',
    'SOUTH KOREA': 'KR', KOREA: 'KR', 'NORTH KOREA': 'KP', CZECHIA: 'CZ', 'CZECH REPUBLIC': 'CZ', TURKEY: 'TR', TURKIYE: 'TR', VIETNAM: 'VN', TAIWAN: 'TW',
    'HONG KONG': 'HK', MACAU: 'MO', MACAO: 'MO', VENEZUELA: 'VE', BOLIVIA: 'BO', IRAN: 'IR', SYRIA: 'SY', TANZANIA: 'TZ', LAOS: 'LA', MOLDOVA: 'MD',
    BRUNEI: 'BN', PALESTINE: 'PS', 'IVORY COAST': 'CI', 'CAPE VERDE': 'CV', SWAZILAND: 'SZ', ESWATINI: 'SZ', HOLLAND: 'NL', EMIRATES: 'AE',
    'UNITED ARAB EMIRATES': 'AE', 'EUROPEAN UNION': 'EU', 'UNITED NATIONS': 'UN'
  };
  // England, Scotland and Wales have flags of their own (a black flag followed by the letters of their subdivision code, hidden in "tag" characters)
  const NATIONS = { ENG: ['gbeng', 'England'], SCO: ['gbsct', 'Scotland'], WAL: ['gbwls', 'Wales'], ENGLAND: ['gbeng', 'England'], SCOTLAND: ['gbsct', 'Scotland'], WALES: ['gbwls', 'Wales'] };
  const EXTRA_NAMES = { EU: 'European Union', UN: 'United Nations' };

  const byAlpha3 = Object.fromEntries(ALPHA3.split(' ').map((pair) => pair.split(':')));
  const nameOfCode = Object.fromEntries(NAMES.split('|').map((pair) => [pair.slice(0, 2), pair.slice(3)]));
  Object.assign(nameOfCode, EXTRA_NAMES);
  const known = new Set(Object.keys(nameOfCode));

  // Names compared without capitals, accents or punctuation: "Côte d'Ivoire" and "cote d ivoire" are the same
  const fold = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

  let byName = null;
  function names() {
    if (byName) return byName;
    byName = new Map();
    for (const [code, name] of Object.entries(nameOfCode)) byName.set(fold(name), code);
    // the names a person would say (South Korea, Russia, Türkiye...) come from the browser when it can tell them
    try {
      const display = new Intl.DisplayNames(['en'], { type: 'region' });
      for (const code of known) {
        if (EXTRA_NAMES[code]) continue;
        const said = display.of(code);
        if (said && said !== code) byName.set(fold(said), code);
      }
    } catch (error) { /* an older browser: the ISO names and the short names below are what there is */ }
    for (const [name, code] of Object.entries(SHORT_NAMES)) byName.set(name, code);
    return byName;
  }

  const REGIONAL = 0x1F1E6; // the "regional indicator" letters: two of them in a row are a flag
  const flagOfCode = (code) => String.fromCodePoint(...[...code].map((letter) => REGIONAL + letter.charCodeAt(0) - 65));
  const flagOfNation = (tag) => String.fromCodePoint(0x1F3F4, ...[...tag].map((letter) => 0xE0000 + letter.charCodeAt(0)), 0xE007F);

  // A flag that is already in the text (it was pasted from somewhere)
  const PASTED = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}/u;

  // Which country the text names: { code, nation } with a two-letter code, or a nation of the United Kingdom, or null
  function find(text) {
    if (typeof text !== 'string') return null;
    const typed = text.trim();
    if (!typed || typed.length > 60) return null;
    const pasted = PASTED.exec(typed);
    if (pasted) return { pasted: pasted[0] };

    const key = fold(typed);
    if (NATIONS[key]) return { nation: NATIONS[key] };
    if (/^[A-Z]{2}$/.test(key)) {
      const code = CODES[key] || key;
      return known.has(code) ? { code } : null;
    }
    if (/^[A-Z]{3}$/.test(key)) {
      const code = byAlpha3[key] || CODES[key];
      if (code) return { code };
    }
    const code = names().get(key);
    return code ? { code } : null;
  }

  // The flag emoji for what was typed, or '' when it is not a country (or a flag) that is known
  function flagOf(text) {
    const found = find(text);
    if (!found) return '';
    if (found.pasted) return found.pasted;
    return found.nation ? flagOfNation(found.nation[0]) : flagOfCode(found.code);
  }

  // The name of that country in English, or '' (for a title on the flag)
  function nameOf(text) {
    const found = find(text);
    if (!found || found.pasted) return '';
    if (found.nation) return found.nation[1];
    try {
      const said = new Intl.DisplayNames(['en'], { type: 'region' }).of(found.code);
      if (said && said !== found.code) return said;
    } catch (error) { /* the ISO name will do */ }
    return nameOfCode[found.code] || '';
  }

  // The codes the control panel offers while someone types a nationality: the three-letter codes of the countries most often seen at tournaments
  const COMMON = ['USA', 'CAN', 'MEX', 'BRA', 'ARG', 'CHL', 'COL', 'PER', 'GBR', 'IRL', 'FRA', 'DEU', 'ESP', 'ITA', 'PRT', 'NLD', 'BEL', 'SWE', 'NOR', 'DNK', 'FIN', 'POL', 'AUT', 'CHE', 'JPN', 'KOR', 'CHN', 'TWN', 'HKG', 'SGP', 'MYS', 'THA', 'IDN', 'PHL', 'VNM', 'IND', 'AUS', 'NZL', 'ZAF'];

  return { flagOf, nameOf, COMMON, ALPHA3: byAlpha3 };
}));
