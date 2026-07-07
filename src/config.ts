// 海しる（海洋状況表示システム）公開API
// https://portal.msil.go.jp/
//
// 下記は海上保安庁がポータルで公開している試用キー。
// 予告なく停止されることがあるため、継続利用する場合は
// 問い合わせフォームから個別キーの発行を申請して差し替えること。
export const MSIL_KEY = "0e83ad5d93214e04abf37c970c32b641";

export const API_BASE = "https://api.msil.go.jp";

// 時刻スライダーの範囲（現在時刻から前後の時間数）と刻み（分）
export const TIME_SPAN_BACK_H = 6;
export const TIME_SPAN_FWD_H = 18;
export const TIME_STEP_MIN = 30;
