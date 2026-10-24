/* Reads Thai bank SMS alerts. Written for KBank, tolerant of other banks' wording.
   parseBankSMS(text, receivedAt) → { amount, type, time, party }
     amount: number (0 if not found)
     type:   'income' | 'expense' | '' (unknown)
     time:   ms timestamp from the text (0 if not found) — SMS times are Thai time (UTC+7)
     party:  who the money came from / went to, if the text says ('' otherwise) */
(function (root) {
  'use strict';

  // Direction words, strongest first. "โอนเงิน" alone is ambiguous, so it's checked last.
  const IN_STRONG = /(เงินเข้า|รับโอน|รับเงิน|โอนเข้า|เข้าบ\/?ช|ฝากเงิน|deposit|received|credited|transfer in|incoming)/i;
  const OUT_STRONG = /(เงินออก|โอนออก|ถอน|ชำระ|จ่าย|หักบัญชี|หักเงิน|ตัดบัญชี|ซื้อ|ใช้บัตร|ใช้จ่าย|withdraw|debit|paid|payment|purchase|spent|transfer out)/i;
  const IN_WEAK = /(คืนเงิน|refund)/i;
  const OUT_WEAK = /(โอนเงิน|transferred|transfer)/i;
  const BAL = /(คงเหลือ|ใช้ได้|\bbal\b|balance|avail)/i;
  const TZ = 7; // Thailand, UTC+7

  function direction(text) {
    if (IN_STRONG.test(text)) return 'income';
    if (OUT_STRONG.test(text)) return 'expense';
    if (IN_WEAK.test(text)) return 'income';
    if (OUT_WEAK.test(text)) return 'expense';
    return '';
  }

  function amountOf(text) {
    const re = /\d[\d,]*(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(text))) {
      const s = m[0], i = m.index, end = i + s.length;
      const prev = text[i - 1] || '', next = text[end] || '';
      const before = text.slice(Math.max(0, i - 18), i);
      const after = text.slice(end, end + 8);
      if ('/:@'.includes(prev) || '/:'.includes(next)) continue;              // dates, times
      if (/^\s*น(\.|\s|$)/.test(after)) continue;                              // "19.45 น." is a time
      if (/[xX*#][\d-]*-?\s?$/.test(before) || /^[xX*#]/.test(next)) continue;  // masked account X123456X
      if (/(บช|บ\/ช|บัญชี|a\/c|acct|account|ref|เลขที่|โทร|tel)\.?\s*[:：]?\s*$/i.test(before)) continue;
      if (BAL.test(before.slice(-12))) continue;                               // the balance, not the amount
      const hasDec = /\.\d{2}$/.test(s);
      const hasCur = /^\s*(บาท|บ(?![ก-๙])|thb|baht|฿)/i.test(after) || /(฿|thb|จำนวน|amount|amt)\s*[:：]?\s*$/i.test(before);
      if (!hasDec && !hasCur) continue;
      const v = parseFloat(s.replace(/,/g, ''));
      if (v > 0 && v < 1e8) return v;
    }
    return 0;
  }

  // Thai local time → timestamp, whatever time zone the phone is in.
  const thaiTime = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - TZ, mi);

  function timeOf(text, ref) {
    const now = ref || Date.now();
    const tm = text.match(/(\d{1,2}):(\d{2})|(\d{1,2})\.(\d{2})\s*น/);
    const h = tm ? +(tm[1] || tm[3]) : 12, mi = tm ? +(tm[2] || tm[4]) : 0;
    if (h > 23 || mi > 59) return 0;
    const dm = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    let t = 0;
    if (dm) {
      const day = +dm[1], mon = +dm[2], y = dm[3];
      if (mon < 1 || mon > 12 || day < 1 || day > 31) return 0;
      const thisYear = new Date(now + TZ * 36e5).getUTCFullYear();
      let year;
      if (!y) year = thisYear;
      else if (y.length <= 2) year = +y >= 60 ? 2500 + +y - 543 : 2000 + +y; // "69" = BE 2569 = 2026
      else year = +y > 2400 ? +y - 543 : +y;
      t = thaiTime(year, mon, day, h, mi);
      if (!y && t > now + 864e5) t = thaiTime(year - 1, mon, day, h, mi);
    } else if (tm) {
      const d = new Date(now + TZ * 36e5);
      t = thaiTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi);
      if (t > now + 10 * 60e3) t -= 864e5; // e.g. 23:50 payment, text arrives 07:00 next day
    }
    return t && t <= now + 864e5 && t >= now - 60 * 864e5 ? t : 0;
  }

  function partyOf(text) {
    const m = text.match(/(?:จาก|ไปยัง|ถึง|ที่(?=\s)|\bfrom\b|\bto\b|\bat\b)\s*[:：]?\s*([^\n]{2,80})/i);
    if (!m) return '';
    const s = m[1].split(/\s+(?=\d[\d,]*\.\d{2}|\d{1,2}\/\d|\d{1,2}:\d{2}|ผ่าน|บช|บ\/ช|บัญชี|a\/c|คงเหลือ|ใช้ได้|จำนวน|เวลา|วันที่|เมื่อ|เข้า|bal\b|ref\b|via\b|on\b)|[,(;]/i)[0].trim();
    if (s.length < 2 || /^(บช|บ\/ช|บัญชี|a\/c)/i.test(s) || /[xX*#]\d|\d[xX*#]/.test(s) || /^[\d\s.,-]+$/.test(s)) return '';
    return s.slice(0, 40);
  }

  function parseBankSMS(text, receivedAt) {
    text = String(text || '')
      .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // full-width → normal
      .replace(/ํา/g, 'ำ') // "ํา" written as two characters → "ำ"
      .replace(/\s+/g, ' ').trim();
    return { amount: amountOf(text), type: direction(text), time: timeOf(text, receivedAt), party: partyOf(text) };
  }

  root.parseBankSMS = parseBankSMS;
  if (typeof module !== 'undefined' && module.exports) module.exports = parseBankSMS;
})(typeof window !== 'undefined' ? window : globalThis);
