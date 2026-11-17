# Game Engine Editor — Kurulum ve Kullanım

## Windows masaüstü uygulaması

1. Proje ana dizinindeki `Game Engine Editor Setup.exe` dosyasını çalıştırın.
2. Kurulum konumunu seçin ve kurulumu tamamlayın.
3. Başlat menüsünden **Game Engine Editor** uygulamasını açın.

Kurulu uygulamayı çalıştırmak için ayrıca Node.js kurmanız gerekmez.
Uygulama kendi penceresinde çalışır ve `127.0.0.1:4319` üzerinde yerel bir
servis başlatır. Başlatma hatası alırsanız bu portu kullanan başka bir program
olmadığını kontrol edin. Yerel servis kimlik doğrulaması sunmaz; uygulamayı
güvenilmeyen ortamlarla paylaşmayın.

Masaüstü sürümünün kayıtları Windows kullanıcı profilindeki uygulama verilerinde
bulunur; web geliştirme sürümündeki `data` klasöründen ve tarayıcı IndexedDB
kayıtlarından ayrıdır. Mevcut web projeleri otomatik aktarılmaz. Yedeklemek için
uygulamayı kapatıp `%APPDATA%\Game Engine Editor` klasörünü kopyalayın.
JSONL eski ve silinmiş proje kayıtlarını da içerebilir.

Kaynak koddan Windows kurulum paketi üretmek için Node.js 22.12 veya üzeri ve
npm kurun; ardından proje klasöründe çalıştırın:

```powershell
npm ci
npm run build:desktop
```

Kurulum dosyası ana dizine kopyalanır; sürümlü çıktısı `release` klasöründe de
bulunur. EXE Git'e eklenmez. Üretilen paket kod imzalı değildir; Windows
yayıncı uyarısı gösterebilir. Kurulum dosyalarını yalnızca güvendiğiniz
kaynaktan çalıştırın.
Kurulum, uygulama ve kısayollar yeni logoyu kullanır. Windows eski simgeyi
önbellekten göstermeye devam ederse Explorer'ı yenileyin veya oturumu yeniden açın.

## Linux ve macOS paketleri

Paketleme altyapısı hazırdır; aşağıdaki komutları ilgili işletim sisteminde
Node.js 22.12 veya üzeri kurulu olarak çalıştırın:

```bash
npm ci
npm run build:linux   # Linux: AppImage ve DEB
npm run build:mac     # macOS: DMG ve ZIP
```

Komutlardan yalnızca kendi işletim sisteminize uygun olanı kullanın. Çıktılar
`release` klasörüne yazılır. Linux ve macOS paketleri henüz bu sistemlerde
üretilip test edilmedi; sistem bağımlılıkları ve mimari için ayrıca doğrulama
gerekir. macOS üzerinde dağıtım için Apple imzası ve notarizasyon gerekir.

## Web geliştirme sürümü

Node.js 22.12 veya üzeri ve npm kurulu bir bilgisayarda proje klasörünü açın:

```powershell
npm ci
npm run dev
```

Terminalde yazan Vite adresini tarayıcıda açın. Yerel proje servisi
`127.0.0.1:4318` portunu kullanır. Durdurmak için terminalde Ctrl+C tuşlayın.
Kaynak kod değişikliklerinden sonra, özellikle sunucu dosyaları değiştiyse,
servisi yeniden başlatın. Servis ve geliştirme sunucusu yalnızca yerel kullanım
içindir; güvenilmeyen ağlara açmayın.

## İlk proje

1. **Projects** düğmesini açın, proje adını yazın ve **New project** seçin.
   Yeni proje geçerli yerel çalışma alanını değiştirir; önceden kaydedin.
2. Soldaki **Components** bölümünden bir **Ground** ve **Box** ekleyin.
3. Nesneyi sahnede veya **In Scene** listesinden seçin. Sağdaki
   **Properties → Transform** ile konumunu, dönüşünü ve ölçeğini değiştirin.
4. **Save** ile projeyi kaydedin; **Projects** listesinden tekrar açabilirsiniz.
5. **Play** ile önizleyin; **Stop** düzenleme durumuna geri döner.

Üst çubuktaki geri/ileri düğmeleri en fazla 20 düzenleme için kullanılır.
Metin alanı dışında Ctrl+Z ve Ctrl+Shift+Z / Ctrl+Y kısayolları da çalışır.

## Model, sahne ve web bileşenleri

- **Load GLB Model** ile bir GLB modeli içe alın veya **Assets** paneline
  dosya yükleyip sahneye ekleyin. Büyük medya proje boyutunu artırır; tek bir
  proje isteği en fazla 50 MiB olabilir.
- **Assets → Scenes / Pages** altında yeni sahneler oluşturun ve adlandırın.
  Bir web düğmesinin **Web action** ayarını sahne geçişi için kullanabilirsiniz.
- Soldaki **Web Components** ile bölüm, kart, başlık, metin, düğme ve medya
  ekleyin. Bileşenleri seçerek sağ panelden içerik, arka plan, ölçü ve düzeni
  ayarlayın. Saydam arka plan ve geçişli işaretçi ayarı 3D içeriğin üstünde
  kullanışlıdır.
- Düzenleme alanındaki **3D / Web** ve cihaz seçenekleriyle görünümü değiştirin.
  Web özelliklerindeki **Layout device** masaüstü, tablet ve mobil için ayrı
  değerler ayarlar; gerçek Play görünümü pencere boyutuna bağlıdır.

## Animasyon ve kamera

1. Bir nesne veya kamera seçin; **In Scene** yanındaki **Timeline** sekmesini açın.
2. Süreyi ve tetiklemeyi belirleyin; özellik seçip **Add channel** veya
   **Add XYZ** ile kanal ekleyin.
3. Anahtar karelerin zamanlarını, değerlerini ve geçiş hızını düzenleyin.
   Cihaz değerleri için masaüstü, tablet veya mobil seçin.
4. **Preview** ve ardından **Play** ile sonucu kontrol edin. GLB klipleri ve
   nesneye bağlı sesler de desteklenen timeline segmentleriyle düzenlenebilir.

Özel kamera kullanmak için bir **Camera** ekleyip **Scene Options → General →
Play Camera** altında seçin.

Nesneyi seçerek özelliklerinde **Tween.js** ile konum, dönüş, ölçek veya
opaklık animasyonu; **Float** ile görsel salınım ayarlayabilirsiniz. Float,
fizik, karakter kontrolü veya AI Navigation etkin nesnelerde çalışmaz ve çakışma
bildirilir. Timeline aynı özelliği kontrol ediyorsa önceliklidir.

**Components** bölümünden **3D Text** veya **SDF Text** ekleyip metin ve boyutu
düzenleyin. SDF yalnızca Latin-1 ve Türkçe karakterleri destekler. **Scene
Options** içinden studio, sunset, night ortamını veya bir HDR dosyasını seçin;
isterseniz arka plan olarak da kullanın. Hazır ortamlar yerel olarak üretilir.

## Dışa aktarma

Üst çubuktan **HTML**, **React** veya **WordPress** seçin ve **Export** düğmesine
basın. Masaüstü sürümünde açılan pencerede ZIP'in kaydedileceği konumu seçin.
İndirilen ZIP'in tüm dosyalarını birlikte kullanın.

- **HTML:** ZIP'i çıkarıp içeriğin tamamını bir web sunucusunda yayınlayın.
  `index.html` dosyasını doğrudan açmak, tarayıcının yerel dosya kısıtlamaları
  nedeniyle modellerin yüklenmesini engelleyebilir. Çok sahneli projede bütün
  sayfa ve JS dosyaları gerekir.
- **React:** ZIP'i çıkarın; klasörde `npm install` ve `npm run dev` çalıştırın.
- **WordPress:** ZIP'i eklenti olarak kurup etkinleştirin ve sayfaya
  `[three_scene]` ekleyin.

React ve WordPress çıktıları üretilen oynatıcıyı iframe içinde barındırır;
yerel React bileşenlerine veya WordPress bloklarına dönüştürmez. Oynatıcı
Three.js ve GLTFLoader yerel dosyalar olarak pakete dahildir; yerel yükleme
başarısız olursa internet bağlantısı ve uygun sunucu politikasıyla CDN denenir. İçe aktarılan
GLB, resim, ses ve video dosyaları sahne oynatıcısının yanındaki
`web3dassets` klasöründedir; bu klasörü diğer çıktı dosyalarıyla birlikte
taşıyın. Harici bağlantılar ve Lottie içindeki gömülü veriler ayrı dosyalara
dönüştürülmez.

Kullanılan Tween.js, metin ve fontların lisansları ilgili ZIP'in `vendor`
klasöründedir. Masaüstü paketindeki bildirimler kurulum dizininde
`resources\third-party` altındadır. GSAP pakete dahil değildir.

## AI ve güvenlik

**Options** altında sağlayıcı ve model seçerek kod asistanını kullanın. Yerel
sağlayıcıların ayrıca çalışıyor olması gerekir. Bulut sağlayıcıların API
anahtarlarını uygulama başlatılmadan önce yerel ortam değişkenleri olarak
ayarlayın; ayrıntılar [FEATURES.md](FEATURES.md) dosyasındadır.
İstem ve seçilen sahne bağlamı onaydan sonra sağlayıcıya gönderilir.
Anahtarları projeye veya isteme yazmayın. Yalnızca güvendiğiniz projeleri
çalıştırın ve üretilen kodu inceleyin; sahne betikleri tam tarayıcı erişimiyle
çalışır.
