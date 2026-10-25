// Shaping corpus. Each string is shaped by Parley (HarfRust) and by HarfBuzz (harfbuzzjs, C++),
// per Parley bidi run, with surrounding context, and compared glyph-by-glyph.
export const arabic = [
  'السلام عليكم',
  'مرحبا بالعالم',
  'اللغة العربية جميلة',
  'لا إله إلا الله', // lam-alef ligatures
  'لأن لإن لآن لا', // lam-alef variants
  'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', // harakat / mark positioning
  'كتب الطالب الدرس في المكتبة',
  'مُحَمَّد',
  'قُلْ هُوَ اللَّهُ أَحَدٌ',
  'ـــبـــ', // tatweel
  'ب ت ث ج ح خ', // isolated forms
  'بتثجحخ', // joined forms
  'فيلم في المساء',
  'يستخدمونها',
  'مستشفى',
  'الذكاء الاصطناعي',
  'تجربة النص العربي مع أرقام ١٢٣٤٥', // Arabic-Indic digits
  'سعر الكتاب 25 دولار', // European digits inside RTL (bidi)
  'هذا نص يحتوي على English words في الوسط', // mixed bidi
  'فارسی زبان شیرین است', // Persian
  'گچپژک', // Persian letters
  'اردو ایک زبان ہے', // Urdu chars (Naskh style in Noto Sans Arabic)
  'ﷺ ﷲ', // presentation forms
  'إِنَّ مَعَ الْعُسْرِ يُسْرًا',
  'وَالشَّمْسِ وَضُحَاهَا',
  'عَلَيْكُمْ',
  'الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ',
  '«مرحبا»، كيف حالك؟', // punctuation + mirroring
  '(قوسين) [معقوفين]', // bracket mirroring
  'حرف لـ متصل',
  'ئ ؤ ء آ أ إ',
  'نظام تشغيل الحاسوب',
  'المملكة العربية السعودية',
  'جمهورية مصر العربية',
  'طاولة',
  'ظلام',
  'عين غين',
  'شمس قمر',
  'هههه',
  'صباح الخير يا صديقي',
];

export const devanagari = [
  'नमस्ते दुनिया',
  'हिन्दी भाषा',
  'क्ष त्र ज्ञ श्र', // conjuncts
  'कर्म धर्म मर्म', // reph
  'कि कि कि किताब', // pre-base matra reordering
  'प्रकाश', // below-base ra
  'राष्ट्र', // multi-conjunct
  'संस्कृत',
  'द्वारा',
  'विद्यालय',
  'शुद्ध',
  'स्त्री',
  'ड़ ढ़ क़ ख़ ग़ ज़ फ़', // nukta
  'अंग्रेज़ी',
  'हृदय',
  'कृष्ण',
  'ट्रक', // half forms / below-base
  'उद्घाटन',
  'श्रीमान',
  'मराठी भाषा र्‍य', // eyelash ra with ZWJ
  'क्‍ष क्‌ष', // ZWJ / ZWNJ control of conjuncts
  'आत्मा',
  'पंक्ति',
  'चिह्न',
  'ब्राह्मण',
  'सत्यमेव जयते',
  'ॐ नमः शिवाय',
  'भारत गणराज्य',
  'प्रधानमंत्री',
  'महत्त्वपूर्ण',
  'अद्भुत',
  'दृष्टि',
  'ऋषि',
  'कौन क्या कब',
  'रुपये रू',
  'ह्म ह्य ह्र ह्व', // ha conjuncts
  '०१२३४५६७८९', // Devanagari digits
  'यह वाक्य हिन्दी में है।',
  'सर्वश्रेष्ठ',
  'ज्योतिर्लिंग',
];
