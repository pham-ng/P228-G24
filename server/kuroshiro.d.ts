// Type stubs for untyped kuroshiro packages
declare module "kuroshiro" {
  interface ConvertOptions {
    to: "hiragana" | "katakana" | "romaji";
    mode?: "normal" | "spaced" | "okurigana" | "furigana";
    romajiSystem?: "nippon" | "passport" | "hepburn";
  }
  export default class Kuroshiro {
    init(analyzer: unknown): Promise<void>;
    convert(text: string, options: ConvertOptions): Promise<string>;
  }
}
declare module "kuroshiro-analyzer-kuromoji" {
  export default class KuromojiAnalyzer {
    constructor(options?: { dictPath?: string });
  }
}
