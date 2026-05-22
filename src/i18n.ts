export interface Labels {
  swing:    string;
  hSwing:   string;
  fanAuto:  string;
  humidity: string;
}

export const TRANSLATIONS: Record<string, Labels> = {
  en:      { swing: 'Swing',        hSwing: 'H-Swing',        fanAuto: 'Fan Auto', humidity: 'Humidity'          },
  ja:      { swing: 'スイング',     hSwing: '水平スイング',    fanAuto: '自動',     humidity: '湿度'              },
  'zh-CN': { swing: '摆风',         hSwing: '水平摆风',        fanAuto: '自动',     humidity: '湿度'              },
  'zh-TW': { swing: '擺風',         hSwing: '水平擺風',        fanAuto: '自動',     humidity: '濕度'              },
  ko:      { swing: '스윙',         hSwing: '수평 스윙',       fanAuto: '자동',     humidity: '습도'              },
  de:      { swing: 'Schwingung',   hSwing: 'H-Schwingung',   fanAuto: 'Auto',     humidity: 'Luftfeuchtigkeit'  },
  fr:      { swing: 'Oscillation',  hSwing: 'Oscillation H',  fanAuto: 'Auto',     humidity: 'Humidité'          },
  es:      { swing: 'Oscilación',   hSwing: 'Oscilación H',   fanAuto: 'Auto',     humidity: 'Humedad'           },
  it:      { swing: 'Oscillazione', hSwing: 'Oscillazione H', fanAuto: 'Auto',     humidity: 'Umidità'           },
  pt:      { swing: 'Oscilação',    hSwing: 'Oscilação H',    fanAuto: 'Auto',     humidity: 'Humidade'          },
  nl:      { swing: 'Schommeling',  hSwing: 'H-Schommeling',  fanAuto: 'Auto',     humidity: 'Vochtigheid'       },
};

export function getLabels(language?: string): Labels {
  return TRANSLATIONS[language ?? 'en'] ?? TRANSLATIONS['en'];
}
