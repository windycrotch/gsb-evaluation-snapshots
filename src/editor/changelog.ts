/**
 * What changed, newest first. The Updates window shows it, and the dot on its button lights up when the newest entry has not been opened yet.
 * Every line has both languages here (the language runtime translates the interface, not data), so a new entry is one object.
 */
export interface Release {
  /** Shown as the title; also what the "seen" mark remembers. */
  version: string;
  date: string;
  en: string[];
  ru: string[];
}

export const CHANGELOG: Release[] = [
  {
    version: '0.92',
    date: '2026-11-21',
    en: [
      'The Metrics window has a "Rig test": it turns every bone that carries a weighted mesh through 20, 35 and 50 degrees (both ways), poses the meshes, and lists the ones whose triangles fold back over themselves, with the bone, the first angle at which it happens and how much of the mesh folds. A click selects the bone and the mesh. It runs on request, only on the bones (constraints and animation are left out), and says nothing about a rig that holds up. The demo fox holds up at 20 degrees; its lone tail, scarf and arm bones do fold at 35 to 50, which is true to the rig and shown as a hint, not as an error.',
    ],
    ru: [
      'В окне «Метрики» появилось «Испытание рига»: каждая кость, которая несёт меш с весами, поворачивается на 20, 35 и 50 градусов (в обе стороны), меши позируются, и список показывает те, у которых треугольники складываются сами на себя: кость, первый угол, на котором это случается, и какая часть меша сложилась. Щелчок выделяет кость и меш. Испытание запускается по кнопке, трогает только кости (констрейнты и анимация не участвуют) и молчит про риг, который держится. Демо-лиса держится на 20 градусах; одиночные кости хвоста, шарфа и руки на 35–50 складываются, это правда про риг и показано как подсказка, а не как ошибка.',
    ],
  },
  {
    version: '0.91',
    date: '2026-11-21',
    en: [
      'The track filter of the timeline can keep only the bones of a selection set: pick a set in the filter window (it shows when the project has any), and a big rig lists just the tail or just the left arm. Deleting the set stops the filtering by itself.',
      'A single selected mesh vertex has two number fields in the inspector, Vertex X and Vertex Y (world, setup pose), for the exact placing that a mouse cannot do. A weighted mesh is moved the same way.',
    ],
    ru: [
      'Фильтр дорожек таймлайна умеет оставлять только кости набора выделения: выберите набор в окне фильтра (он показывается, когда в проекте есть наборы), и большой риг покажет только хвост или только левую руку. Если набор удалить, фильтр по нему отключается сам.',
      'У одной выбранной вершины меша в инспекторе два числовых поля, «Вершина X» и «Вершина Y» (мир, поза установки): для точной расстановки, которую мышью не сделать. Меш с весами двигается так же.',
    ],
  },
  {
    version: '0.90',
    date: '2026-11-21',
    en: [
      'The Metrics window got an "Animation check": it finds a cycle whose end does not match its start (a jump when it repeats), a bone that turns more than half a circle between two keys, keys after the end of the animation, two keys at one time, and animations that have a key on nearly every frame. It also finds names with a side but no pair (Swap sides and Mirror skip those bones) and sides written in different ways. A click goes to the animation, the moment and the bone; a broken cycle has a Fix button. These are hints, never errors: nothing blocks an export, and the demo fox gets none.',
    ],
    ru: [
      'В окне «Метрики» появилась «Проверка анимации»: она находит цикл, у которого конец не совпадает с началом (скачок при повторе), кость, которая поворачивается больше чем на пол-оборота между двумя ключами, ключи за концом анимации, два ключа в одно время и анимации с ключом почти на каждом кадре. А ещё имена со стороной, но без пары («Поменять стороны» и зеркало такие кости пропускают), и стороны, записанные по-разному. Щелчок ведёт к анимации, моменту и кости; у сломанного цикла есть кнопка «Исправить». Это подсказки, а не ошибки: экспорт ничто не блокирует, а у демо-лисы замечаний нет.',
    ],
  },
  {
    version: '0.89',
    date: '2026-11-21',
    en: [
      'Under the hood, after a review of the project: the lesson counters live in one object that every lesson start renews, the lesson buttons of Help carry their own marks (the tests no longer count buttons by position), and the inspectors of clipping, bounding box, path, point and region attachments moved out of the big inspector file. Nothing changes on the screen.',
    ],
    ru: [
      'Под капотом, после ревью проекта: счётчики уроков собраны в один объект, который обновляется при каждом старте урока, кнопки уроков в справке получили свои метки (тесты больше не считают кнопки по порядку), а инспекторы обрезки, области, пути, точки и региона вынесены из большого файла инспектора. На экране ничего не меняется.',
    ],
  },
  {
    version: '0.88',
    date: '2026-11-21',
    en: [
      'Lesson 7, "Out to the game": open Export, download the Spine 4.3 ZIP and save the one-file player page. The lesson counts the files the window really gives out, so a closed window or a cancelled build is not a step. It is the last of the seven lessons: the sixth one offers it when it is over, and the Learn menu lists all seven.',
    ],
    ru: [
      'Урок 7 «В игру»: откройте «Экспорт», скачайте ZIP Spine 4.3 и сохраните страницу-плеер одним файлом. Урок считает файлы, которые окно действительно выдало, так что закрытое окно или недоделанная сборка не засчитываются. Это последний из семи уроков: шестой предлагает его в конце, а меню «Обучение» показывает все семь.',
    ],
  },
  {
    version: '0.87',
    date: '2026-11-21',
    en: [
      'Lesson 6, "Another look and a signal": add a skin, switch between skins, add an event, switch to Animate, fire the event on the timeline with the diamond and play. Nothing is hidden behind a menu: both plus buttons and the diamond are in the tree on the left, and the card frames it. It works on the demo fox, which already has two skins and events, and counts only what you add. The fifth lesson now offers it when it is over.',
    ],
    ru: [
      'Урок 6 «Другой облик и сигнал»: добавьте скин, переключайтесь между скинами, добавьте событие, перейдите в «Анимацию», выстрелите событием ромбиком на таймлайне и проиграйте. Ничего не спрятано в меню: оба плюса и ромбик лежат в списке слева, и карточка обводит его рамкой. Урок идёт на демо-лисе, где скины и события уже есть, и считает только то, что добавили вы. Пятый урок теперь предлагает его, когда закончен.',
    ],
  },
  {
    version: '0.86',
    date: '2026-11-20',
    en: [
      'Lesson 5, "The feel of a motion": switch to Animate, select a key, change its interpolation, open the curve graph, pull a curve handle and play. The lesson tells a change of interpolation from a drag of a handle, so each step asks for the right thing. The fourth lesson offers it when it is over.',
    ],
    ru: [
      'Урок 5 «Характер движения»: перейдите в «Анимацию», выберите ключ, смените его интерполяцию, откройте график кривых, потяните ручку кривой и проиграйте. Урок отличает смену интерполяции от перетаскивания ручки, поэтому каждый шаг просит именно своё. Четвёртый урок предлагает этот в конце.',
    ],
  },
  {
    version: '0.85',
    date: '2026-11-20',
    en: [
      'Lesson 4, "A leg that follows": pick the end of a limb, press I and drag out an IK target, pull it, switch to Animate, key the target and play. The limb follows the target, so you animate one thing instead of every bone. The third lesson offers it when it is over. The IK tool button is framed when the step asks for it.',
    ],
    ru: [
      'Урок 4 «Нога, которая следует за целью»: выберите конец конечности, нажмите I и протяните IK-цель, подвигайте её, перейдите в «Анимацию», поставьте ключ на цель и проиграйте. Конечность следует за целью, так что анимируется одна вещь, а не каждая кость. Третий урок предлагает этот в конце. Кнопка инструмента IK подсвечивается, когда шаг на неё указывает.',
    ],
  },
  {
    version: '0.84',
    date: '2026-11-20',
    en: [
      'A "Learn" button in the top bar, next to Export: a menu with every lesson (a tick on the ones you finished) and a dot on it until you finish the first one. In a narrow window it keeps only its icon. An empty project also offers "Take the 2-minute tutorial" next to the demo button.',
    ],
    ru: [
      'Кнопка «Обучение» в верхней панели, рядом с «Экспортом»: меню со всеми уроками (у пройденных галочка) и точка на кнопке, пока не пройден первый урок. В узком окне остаётся только значок. В пустом проекте рядом с кнопкой демо также есть «Пройти мини-обучение за 2 минуты».',
    ],
  },
  {
    version: '0.83',
    date: '2026-11-20',
    en: [
      'Lesson 3, "A picture that bends": pick a picture, make it a mesh (Quad or Trace mesh), bind it to bones, look at the weights with the brush (W), then switch to Animate and bend it with a turn of a bone. The second lesson offers it when it is over, and Help lists it.',
      'In a lesson, a step that was done stays done: selecting a bone drops the selected picture, and the card used to jump back to the first step.',
    ],
    ru: [
      'Урок 3 «Картинка, которая гнётся»: выберите картинку, сделайте из неё сетку («Квадрат» или «Трассировать сетку»), привяжите к костям, посмотрите на веса кистью (W), затем перейдите в «Анимацию» и согните её поворотом кости. Второй урок предлагает этот в конце, а справка показывает его в списке.',
      'В уроке выполненный шаг остаётся выполненным: выбор кости снимал выбор картинки, и карточка возвращалась к первому шагу.',
    ],
  },
  {
    version: '0.82',
    date: '2026-11-20',
    en: [
      'Lesson 2, "Your own rig": from a picture to a moving bone in six steps (bring pictures, draw a bone with B, put a picture on it, switch to Animate, turn the bone, play). No pictures at hand: a button in the first step adds two sample ones. It works on any project, new or not. The first lesson now offers it when it is over, and Help lists all the lessons.',
    ],
    ru: [
      'Урок 2 «Свой риг»: от картинки до движущейся кости за шесть шагов (добавить картинки, нарисовать кость на B, посадить на неё картинку, перейти в «Анимацию», повернуть кость, проиграть). Нет картинок под рукой: кнопка в первом шаге добавит две учебные. Работает на любом проекте, новом и нет. Первый урок в конце предлагает этот, а справка показывает список всех уроков.',
    ],
  },
  {
    version: '0.81',
    date: '2026-11-20',
    en: [
      'An interactive lesson: "Bring the fox to life". A small card in the corner of the viewport leads you through six steps on the demo rig: pick a bone, change it, switch to Animate, play, make your own key, open Export. The editor itself checks each step (it is done when the editor is in the state the step asks for), so you can do the steps in any order and skip what you know. A soft frame shows where to look. It starts by itself the first time you open the demo (also from a demo link) and never again on its own; Help, the welcome window and the command palette start it whenever you want.',
    ],
    ru: [
      'Интерактивный урок «Оживите лису». Небольшая карточка в углу вьюпорта ведёт по шести шагам на демо-риге: выбрать кость, изменить её, перейти в «Анимацию», проиграть, поставить свой ключ, открыть «Экспорт». Редактор сам проверяет каждый шаг (шаг выполнен, когда редактор в том состоянии, которого он просит), поэтому шаги можно делать в любом порядке и пропускать знакомые. Мягкая рамка показывает, куда смотреть. Урок сам запускается при первом открытии демо (в том числе по ссылке на демо) и больше не навязывается; из справки, приветственного окна и палитры команд его можно запустить когда угодно.',
    ],
  },
  {
    version: '0.80',
    date: '2026-11-20',
    en: [
      'Exporting an animation no longer freezes the editor: the GIF, APNG and PNG/JPEG-sequence files are put together in a background worker, so you can keep working while a long animation is encoded. Cancel stops it at once (before, it could only stop between frames and the final step could not be stopped at all). Package Project uses the worker too.',
    ],
    ru: [
      'Экспорт анимации больше не вешает редактор: файлы GIF, APNG и серии PNG/JPEG собираются в фоновом воркере, и пока кодируется длинная анимация, можно работать дальше. «Отмена» останавливает сразу (раньше она работала только между кадрами, а завершающий шаг остановить было нельзя). «Упаковать проект» тоже идёт через воркер.',
    ],
  },
  {
    version: '0.79',
    date: '2026-11-20',
    en: [
      'No more flashing while a panel is dragged: the viewport, the dopesheet, the graph and the rulers used to show one empty frame at every step (a resized canvas is wiped, and it was painted again only in the next frame); they are painted at once now.',
      'Opening a rig is much faster: the pictures of a project file are read directly instead of through the network stack (a rig with twenty large pictures froze the editor for about two seconds) and decoded all at once.',
      'Loading the demo rig while another rig is open no longer turns the open one white: the new pictures are made first and swapped in together with the rig.',
    ],
    ru: [
      'Экран больше не мигает, когда тянешь панель: вьюпорт, таблица ключей, график и линейки показывали один пустой кадр на каждом шаге (при смене размера canvas стирается, а перерисовывался он только в следующем кадре); теперь он рисуется сразу.',
      'Рига открываются заметно быстрее: картинки из файла проекта читаются напрямую, а не через сетевой стек (риг из двадцати больших картинок вешал редактор примерно на две секунды), и декодируются все сразу.',
      'Загрузка демо-рига при открытом другом риге больше не заливает открытый белым: новые картинки сначала готовятся и подставляются вместе с ригом.',
    ],
  },
  {
    version: '0.78',
    date: '2026-11-20',
    en: [
      'The welcome window has the EN / RU switch, so the very first screen can be read in your language.',
      'Menus and windows no longer stretch the page: a menu that is taller than the room below it scrolls inside itself, and one that would run past an edge is moved back into the window (the Windows menu, the timeline menus, the track filter).',
      'Screen readers: every field and list now has a name (for example "Position X"), the page has a header, a main area and named side panels, dialog titles are headings, and the dopesheet can be reached with the keyboard. Checked with axe-core on the welcome window, the editor, an animated bone, a weighted mesh and the Export, Settings and Help windows, in English and Russian.',
      'Narrow panels, round two: a deep chain in the hierarchy no longer pushes names and buttons out (the indent flattens after five levels, the hover buttons float over the end of the row), and a button with a long label wraps instead of sticking out of the Inspector.',
    ],
    ru: [
      'В приветственном окне есть переключатель EN / RU: первый же экран можно прочитать на своём языке.',
      'Меню и окна больше не растягивают страницу: меню выше свободного места прокручивается внутри себя, а то, что вылезло бы за край, сдвигается обратно в окно (меню «Окна», меню таймлайна, фильтр дорожек).',
      'Для экранных дикторов: у каждого поля и списка есть имя (например, «Позиция X»), у страницы есть шапка, основная область и подписанные боковые панели, заголовки окон — заголовки, а таблица ключей доступна с клавиатуры. Проверено axe-core на приветственном окне, редакторе, анимированной кости, меше с весами и окнах «Экспорт», «Настройки» и «Справка», на английском и русском.',
      'Узкие панели, второй заход: длинная цепочка в иерархии больше не выталкивает имена и кнопки (отступ после пятого уровня сужается, кнопки при наведении лежат поверх конца строки), а кнопка с длинной подписью переносится на вторую строку и не торчит из инспектора.',
    ],
  },
  {
    version: '0.77',
    date: '2026-11-20',
    en: [
      'Narrow panels: with a panel dragged to its smallest width, nothing is cut off any more. A row of fields puts its label above the fields (they wrap onto a second line), long labels of a field end with "…", and a section title with long buttons moves them to a second line. The window itself has a smallest size of 1100 × 560, below that the page scrolls.',
    ],
    ru: [
      'Узкие панели: когда панель сдвинута до минимума, ничего больше не обрезается. Строка полей ставит подпись над полями (они переносятся на вторую строку), длинная подпись поля заканчивается на «…», а заголовок секции с длинными кнопками переносит их на вторую строку. У окна есть минимальный размер 1100 × 560, меньше страница прокручивается.',
    ],
  },
  {
    version: '0.76',
    date: '2026-11-20',
    en: [
      'Links that open the demo: ?demo opens the fox, ?demo=wave opens it playing the wave animation (also walk, jump, idle). If you worked here before, your earlier work is copied to the History window first.',
    ],
    ru: [
      'Ссылки, открывающие демо: ?demo открывает лису, ?demo=wave открывает её с играющей анимацией wave (есть ещё walk, jump, idle). Если вы здесь уже работали, прежняя работа сначала копируется в окно «История».',
    ],
  },
  {
    version: '0.75',
    date: '2026-11-20',
    en: [
      'Demo fox: in the wave the far (left) arm no longer comes out in front of the body and sticks forward. It stays behind the body and only lifts a little, as it must for an arm on the other side of the fox.',
    ],
    ru: [
      'Демо-лиса: в анимации «wave» дальняя (левая) рука больше не выходит поверх тела и не торчит вперёд. Она остаётся за телом и лишь слегка приподнимается, как и должна рука с другой стороны лисы.',
    ],
  },
  {
    version: '0.73',
    date: '2026-11-20',
    en: [
      'The Export window is in groups: Skeleton data (file, size, editor data, clean-up, mix table, preview page), the animations to export, then Atlas (page size, padding, filter) with the rarely needed options folded under Advanced atlas options.',
      'Long explanations in the inspector show two lines and open on a click, so a bone with many tools no longer needs a long scroll. With nothing selected the inspector shows what the skeleton holds (bones, slots, animations, skins, pictures) and how many warnings the project check has.',
      'In Setup mode the note about switching to Animate is a strip above the timeline instead of a card over the keys. Names cut off in the hierarchy show in full on hover. The five small icons of the Images panel are one button and a menu.',
    ],
    ru: [
      'Окно экспорта разбито на группы: «Данные скелета» (файл, размер, данные редактора, очистка, таблица переходов, страница предпросмотра), анимации для экспорта, затем «Атлас» (размер страницы, отступ, фильтр); редкие настройки свёрнуты в «Дополнительные настройки атласа».',
      'Длинные пояснения в инспекторе показывают две строки и раскрываются по клику, поэтому у кости с множеством инструментов не нужна длинная прокрутка. Когда ничего не выбрано, инспектор показывает, что есть в скелете (кости, слоты, анимации, скины, картинки) и сколько предупреждений у проверки проекта.',
      'В режиме «Риг» подсказка про переход в «Анимацию» теперь полоса над таймлайном, а не карточка поверх ключей. Обрезанные имена в иерархии показываются целиком при наведении. Пять мелких иконок панели «Картинки» стали одной кнопкой и меню.',
    ],
  },
  {
    version: '0.71',
    date: '2026-11-20',
    en: [
      "Layout fixes: the icons of the buttons are in the middle of their buttons now (every icon button had the browser's default padding and the icon sat 1 to 3 pixels to the right), the fields and buttons of the timeline bar have one height, the bars of the Constraints, Skins and Events sections and the zoom chip are centred.",
      'A narrower window no longer cuts things off: the timeline bar gives up its least needed controls in order (the labels of Insert time and Delete time, then that group, the options, the tail) instead of hiding the buttons on its right, and the top bar drops the feedback, help, updates and search buttons so Export stays in view down to 1100 pixels.',
      'The buttons of a long dialog (Export) stay at the bottom while the form scrolls, and the tip of the chosen tool fades out after a few seconds instead of covering the picture for good.',
    ],
    ru: [
      'Исправления вёрстки: иконки на кнопках теперь стоят по центру (у каждой иконочной кнопки был отступ браузера по умолчанию, и иконка сидела на 1–3 пикселя правее), поля и кнопки панели таймлайна одной высоты, заголовки разделов «Констрейнты», «Скины», «События» и плашка масштаба выровнены по центру.',
      'Узкое окно больше ничего не обрезает: панель таймлайна по очереди отказывается от наименее нужного (подписей «Вставить время» и «Удалить время», затем всей этой группы, настроек, хвоста) вместо того, чтобы прятать кнопки справа, а верхняя панель убирает кнопки обратной связи, справки, обновлений и поиска, так что «Экспорт» остаётся на виду до ширины 1100 пикселей.',
      'Кнопки длинного окна (Экспорт) остаются внизу, пока форма прокручивается, а подсказка выбранного инструмента через несколько секунд гаснет, а не закрывает картинку навсегда.',
    ],
  },
  {
    version: '0.70',
    date: '2026-11-20',
    en: [
      'The demo rig Kit looks better: the far ear has a picture of its own that stands along its bone (before, it was a copy of the near ear and leaned the same way), and the tail is drawn between the two arms (in front of the far arm, behind the body and the near arm) instead of behind everything.',
      'The repository is tidied up for newcomers: a README with a picture and highlights, CONTRIBUTING, a code of conduct, issue and pull request templates, a CI check, docs/ARCHITECTURE.md.',
    ],
    ru: [
      'Демо-риг Kit выглядит лучше: у дальнего уха теперь своя картинка, которая стоит вдоль своей кости (раньше это была копия ближнего уха, и оба наклонялись одинаково), а хвост нарисован между двумя руками (перед дальней рукой, за телом и ближней рукой), а не позади всего.',
      'Репозиторий приведён в порядок для новичков: README с картинкой и краткими возможностями, CONTRIBUTING, кодекс поведения, шаблоны issue и pull request, проверка CI, docs/ARCHITECTURE.md.',
    ],
  },
  {
    version: '0.69',
    date: '2026-11-20',
    en: [
      'Fixed: the keyboard shortcuts did nothing with a Russian (or any other non-Latin) keyboard layout. Ctrl+Z, Ctrl+Y, Ctrl+S, Ctrl+C and the others, and the tool letters, read the letter that was typed ("я" instead of Z); now a letter or a punctuation key that is not Latin is read from the position of the key, the way it is on a US keyboard. Layouts that have Latin letters (German, French) still use the typed letter. Remapping a tool letter in Settings works on any layout too.',
    ],
    ru: [
      'Исправлено: горячие клавиши ничего не делали на русской (и любой другой нелатинской) раскладке. Ctrl+Z, Ctrl+Y, Ctrl+S, Ctrl+C и остальные, а также буквы инструментов читали напечатанную букву («я» вместо Z); теперь нелатинская буква или знак читаются по положению клавиши, как на американской клавиатуре. Раскладки с латинскими буквами (немецкая, французская) по-прежнему используют напечатанную букву. Переназначение буквы инструмента в настройках тоже работает на любой раскладке.',
    ],
  },
  {
    version: '0.68',
    date: '2026-11-19',
    en: [
      'Compare, take the parts you want: every difference that is gone here or differs now has a tick box in the Checkpoints list, and Take brings the ticked ones from the checkpoint or from the compared project file into the skeleton as one step (Undo takes it back). A bone that comes back brings the bones it hangs on, a slot its attachments in the skins, a constraint what it works on, a skin or animation the whole thing; the pictures a taken skin needs are read from the file. Nothing the open skeleton has and the other version lacks is ever deleted, and a bone is never hung under its own child.',
      'A compared project file can be gone back to as a whole now (the button was greyed out): the skeleton becomes the one in the file and the pictures it has that the project lacks are read from it. One step of the history.',
    ],
    ru: [
      'Сравнение: взять нужное. У каждого различия, которого здесь нет или которое теперь иное, в списке контрольных точек есть флажок, а кнопка «Взять» переносит отмеченное из контрольной точки или сравниваемого файла проекта в скелет одним шагом (Отмена возвращает). Вернувшаяся кость приносит кости, на которых висит, слот приносит свои картинки в скинах, констрейнт то, с чем работает, скин или анимация приходят целиком; картинки, нужные взятому скину, читаются из файла. Ничего, что есть в открытом скелете и нет в другой версии, не удаляется, и кость никогда не подвешивается под собственного потомка.',
      'К сравниваемому файлу проекта теперь можно вернуться целиком (кнопка была неактивна): скелет становится таким, как в файле, а картинки, которые есть в файле и которых нет в проекте, читаются из него. Один шаг истории.',
    ],
  },
  {
    version: '0.67',
    date: '2026-11-19',
    en: [
      'Player page: a reviewer can now click a bone in the picture to point the comment at it (the bone is lit up, shown in the comment box and written into the file; a click on nothing lets go, a drag still pans). The comment box is a small card in the corner now, so the picture stays clickable while the note is written.',
      'Player page language: the page picks Russian or English by the language of the browser that opens it (Russian for ru, English for everything else), so a reviewer who never saw the editor gets the buttons in their own language.',
      "Comments window (Windows → Comments): every review comment of the project in one list, open ones first. A click goes to the animation, the moment and the bone; a button marks a comment resolved or opens it again; Mark every open comment resolved does all at once; the list can hide the resolved ones and imports a reviewer's file.",
    ],
    ru: [
      'Страница-плеер: рецензент теперь может щёлкнуть кость на картинке, чтобы указать на неё в комментарии (кость подсвечивается, показывается в окне комментария и пишется в файл; щелчок по пустому месту отпускает кость, перетаскивание по-прежнему двигает картинку). Окно комментария теперь маленькая карточка в углу, поэтому картинка остаётся доступной для щелчка, пока пишется заметка.',
      'Язык страницы-плеера: страница выбирает русский или английский по языку браузера, который её открывает (русский для ru, английский для остальных), так что рецензент, который не видел редактор, получает кнопки на своём языке.',
      'Окно «Комментарии» (Окна → Комментарии): все замечания рецензентов проекта одним списком, открытые сверху. Щелчок ведёт к анимации, моменту и кости; кнопка отмечает комментарий решённым или открывает снова; «Отметить все открытые комментарии решёнными» делает это разом; список умеет прятать решённые и импортирует файл рецензента.',
    ],
  },
  {
    version: '0.66',
    date: '2026-11-19',
    en: [
      'Insert time / Delete time: next to the animation length the timeline has a number of frames and two buttons. Insert time pushes every key, marker and the play range from the playhead on later by that many frames (a pause in the middle of a walk) and makes the animation longer; Delete time cuts the frames after the playhead out (the keys inside go, the later keys move earlier, the animation gets shorter). One undo step each; also in the command palette.',
      'Saved curves: right-click a key with a bezier curve → Save this curve… keeps it under a name; the same menu then puts it on other keys. Settings → Saved curves lists them and forgets them (up to twelve, kept in the browser).',
      'Select next to the hierarchy filter: a button selects every bone and slot that matches what was typed (several slots are selected together, so the weight tools work on all their meshes).',
      'The Dopesheet of a looping animation draws faint copies of the keys before 0 and after the end, so the seam of a loop can be checked on the timeline.',
    ],
    ru: [
      'Вставить время / Удалить время: рядом с длиной анимации на таймлайне есть число кадров и две кнопки. «Вставить время» сдвигает все ключи, маркеры и диапазон проигрывания от маркера времени позже на столько кадров (пауза посреди шага) и удлиняет анимацию; «Удалить время» вырезает кадры после маркера (ключи внутри пропадают, поздние ключи сдвигаются раньше, анимация короче). Каждое одним шагом отмены; также в палитре команд.',
      'Сохранённые кривые: правый щелчок по ключу с кривой Безье → «Сохранить эту кривую…» оставляет её под именем; в том же меню её можно поставить на другие ключи. «Настройки → Сохранённые кривые» перечисляет их и позволяет забыть (до двенадцати, хранятся в браузере).',
      '«Выделить» рядом с фильтром иерархии: кнопка выделяет все кости и слоты, подходящие под набранное (несколько слотов выделяются вместе, поэтому инструменты весов работают на всех их мешах).',
      'Dopesheet зацикленной анимации рисует бледные копии ключей до 0 и после конца, чтобы шов цикла был виден на таймлайне.',
    ],
  },
  {
    version: '0.65',
    date: '2026-11-19',
    en: [
      'Paste Keys - Hold (Spine 4.3): Ctrl+Shift+V (also in the timeline menu and the command palette) pastes the copied keys and makes every segment between two keys of the same value linear, so a copied curve cannot swing away from a value it starts and ends on. Plain Ctrl+V keeps the curves as they were copied.',
      'Flip Viewport (Spine 4.3): Ctrl+Shift+F (View menu, command palette) mirrors the view left to right and back. The picture, the bones, the handles, picking, panning and zooming all follow; only the way the scene is looked at changes, nothing in the file.',
      "Atlas per skin (Spine 4.3): the export dialog has an Atlas per skin switch. The default skin keeps the plain atlas name, and each other skin gets its own atlas (name-skin.atlas and its pages) with the pictures the default skin does not use, so a game loads a skin's pictures when it needs them. The preview page plays all of them, and What the engine needs says which atlases to load.",
    ],
    ru: [
      'Paste Keys - Hold (Spine 4.3): Ctrl+Shift+V (также в меню таймлайна и палитре команд) вставляет скопированные ключи и делает линейным каждый отрезок между ключами с одним значением, чтобы скопированная кривая не уходила от значения, с которого начинается и на котором заканчивается. Обычный Ctrl+V оставляет кривые как они были скопированы.',
      'Flip Viewport (Spine 4.3): Ctrl+Shift+F (меню «Вид», палитра команд) зеркалит вид слева направо и обратно. Картинка, кости, рукоятки, выбор, панорамирование и зум следуют за этим; меняется только то, как смотрят на сцену, в файле ничего.',
      'Атлас на каждый скин (Spine 4.3): в окне экспорта есть переключатель «Атлас на каждый скин». Стандартный скин сохраняет обычное имя атласа, а у каждого другого скина свой атлас (имя-скин.atlas и его страницы) с картинками, которых нет у стандартного скина, чтобы игра загружала картинки скина, когда они нужны. Страница просмотра играет все атласы, а «Что нужно движку» подсказывает, какие атласы загружать.',
    ],
  },
  {
    version: '0.64',
    date: '2026-11-19',
    en: [
      'Weights of several meshes at once (Spine 4.3): Ctrl-click more slots in the tree next to the selected one. The Weights section then says how many meshes work together, and Bind, Add bones, Auto, Smooth, Prune, Swap, Unbind and removing a bone from the list act on all of them in one undo step. The weight brush paints every mesh of the group that follows its bone (the meshes the bone does not move are left alone). Selected vertices still limit the tools on the mesh they belong to; the others work on the whole mesh.',
      'Trace several meshes at once (Spine 4.3): with several image slots selected, Trace mesh and Quad turn all their images into meshes in one step, and Re-trace does the same for the unweighted meshes of the group. The group stays selected afterwards.',
    ],
    ru: [
      'Веса нескольких мешей сразу (Spine 4.3): Ctrl+щелчок по другим слотам в дереве рядом с выбранным. Раздел «Веса» тогда показывает, сколько мешей работают вместе, а «Привязать», «Добавить кости», Auto, Smooth, Prune, Swap, Unbind и удаление кости из списка действуют на все они одним шагом отмены. Кисть весов красит каждый меш группы, который следует за её костью (меши, которые кость не двигает, не трогаются). Выбранные вершины по-прежнему ограничивают инструменты на своём меше; на остальных они работают на весь меш.',
      'Трассировка нескольких мешей сразу (Spine 4.3): когда выбрано несколько слотов с картинками, «Трассировка» и «Квадрат» превращают все их картинки в меши одним шагом, а «Повторная трассировка» делает то же для мешей группы без весов. Группа после этого остаётся выбранной.',
    ],
  },
  {
    version: '0.63',
    date: '2026-11-19',
    en: [
      'Copy keys from several bones and paste them onto other bones (Spine 4.3): select the keys of two or more bones, copy, select as many other bones and paste: the bones are matched one for one in the order of the document (the first copied bone to the first selected one, and so on), like pasting bone transforms. With a different number of bones selected, or the same bones, the keys stay where they were.',
      'Dopesheet-centric sync of the Graph (Spine 4.3): a key selected in the Dopesheet shows its own timeline in the Graph (the selected bones when no key is selected). Settings → Graph shows (or the link button next to the graph button) switches to "Selected bones": the Graph then always shows the timelines of the selected bones, whatever keys are selected.',
    ],
    ru: [
      'Копирование ключей с нескольких костей на другие кости (Spine 4.3): выделите ключи двух и более костей, скопируйте, выделите столько же других костей и вставьте: кости сопоставляются одна к одной в порядке документа (первая скопированная кость на первую выделенную и так далее), как при вставке трансформаций костей. Если выделено другое число костей или те же самые кости, ключи остаются на своих местах.',
      'Синхронизация графика от Dopesheet (Spine 4.3): ключ, выбранный в Dopesheet, показывает свою дорожку в графике (выбранные кости, когда ключей нет). «Настройки → График показывает» (или кнопка-звено рядом с кнопкой графика) переключает на «Выбранные кости»: тогда график всегда показывает дорожки выбранных костей, какие бы ключи ни были выбраны.',
    ],
  },
  {
    version: '0.62',
    date: '2026-11-19',
    en: [
      'Reset on a path (Spine 4.3): the Path section of the inspector has a Reset path button that puts the path back to a straight line of two nodes around its bone (weights and deform keys of the old path go, one undo step).',
      'Breadcrumbs of the selection (Spine 4.3): a trail over the viewport shows skeleton › parent bones › bone › slot › attachment; a click on a bone or a slot selects it. Settings → Breadcrumb parents sets how many parent bones it lists (0 to 10).',
      'Bone size is a slider now (25 to 300 percent), and a bone without length is drawn as a small arrow along its x axis; Settings → Bone icon rotation turns that arrow (only how it looks in the editor).',
    ],
    ru: [
      'Сброс у path (Spine 4.3): в разделе «Путь» инспектора есть кнопка «Сбросить путь»: путь возвращается к прямой из двух узлов около своей кости (веса и ключи деформации старого пути пропадают, один шаг отмены).',
      'Хлебные крошки выделения (Spine 4.3): цепочка над окном показывает скелет › родительские кости › кость › слот › вложение; щелчок по кости или слоту выделяет его. «Настройки → Родителей в хлебных крошках» задаёт, сколько родительских костей она перечисляет (от 0 до 10).',
      'Размер кости теперь ползунок (от 25 до 300 процентов), а кость без длины рисуется маленькой стрелкой вдоль своей оси x; «Настройки → Поворот значка кости» поворачивает эту стрелку (меняет только вид в редакторе).',
    ],
  },
  {
    version: '0.61',
    date: '2026-11-19',
    en: [
      'Metrics → Before export is now a list of problems with a fix: each warning that can be put right has a Fix button (remove an unused image, keep the 4 strongest bones of a vertex that has more, delete deform keys on a linked mesh that the export ignores, delete an empty animation or an empty slot), and a click on the name takes you to the slot or animation.',
      'Fix all that are safe does the first three kinds at once in one undo step; the ones that delete something a person may have made on purpose (an empty animation or slot) are only done one at a time. Deform keys follow the changed weights, and a linked mesh is fixed through its source.',
      'An image that another skeleton of the project shows is no longer reported as unused.',
    ],
    ru: [
      'Metrics → «Перед экспортом» теперь список проблем с исправлением: у каждого предупреждения, которое можно исправить, есть кнопка «Исправить» (убрать неиспользуемую картинку, оставить у вершины 4 самые сильные кости, если их больше, удалить ключи деформации связанного меша, которые экспорт игнорирует, удалить пустую анимацию или пустой слот), а щелчок по имени ведёт к слоту или анимации.',
      '«Исправить безопасное» делает первые три вида сразу, одним шагом отмены; то, что удаляет вещи, которые человек мог оставить нарочно (пустая анимация или слот), делается только по одному. Ключи деформации следуют за изменёнными весами, а связанный меш исправляется через источник.',
      'Картинка, которую показывает другой скелет проекта, больше не считается неиспользуемой.',
    ],
  },
  {
    version: '0.60',
    date: '2026-11-19',
    en: [
      'Export → What the engine needs: before the file is sent off, the dialog lists what this skeleton and these settings ask of the game: the features the engine has to support (two colour tint, blend modes, clipping, physics, sliders, sequences, draw order folders, a linked mesh in another slot) and what to match on the engine side (the 4.3 runtime version, binary loader, premultiplied alpha, Nearest filter, rotated pictures, scale, event audio).',
      'Why: the most common reason an animation looks different in the game than in the editor, in the Spine forum threads, is a mismatch of runtime version, alpha mode or an unsupported feature. The list is read from the data only (nothing guesses what a particular engine does).',
    ],
    ru: [
      'Экспорт → «Что нужно движку»: перед отправкой файла окно перечисляет, чего этот скелет и эти настройки требуют от игры: возможности, которые движок обязан поддерживать (двухцветная заливка, режимы смешивания, clipping, физика, слайдеры, последовательности, папки порядка отрисовки, связанный меш в другом слоте), и что согласовать на стороне движка (версия рантайма 4.3, бинарный загрузчик, премультиплицированная альфа, фильтр Nearest, повёрнутые картинки, масштаб, звук событий).',
      'Зачем: самая частая причина, почему анимация в игре выглядит иначе, чем в редакторе, в ветках форума Spine — несовпадение версии рантайма, режима альфы или неподдерживаемая возможность. Список читается только из данных (ничего не угадывается про конкретный движок).',
    ],
  },
  {
    version: '0.59',
    date: '2026-11-19',
    en: [
      "Compare with a project file (Checkpoints → the file-diff button, or the command palette): another version of the project, such as a teammate's copy or an older save, is read without opening it, shown as a pose under the current one and listed as what was added, removed and changed (bones, slots, skins, constraints, events, animations with their key counts). Things are matched by id, so it fits copies of the same project. Copy changes puts the list on the clipboard as plain text for a message or a review.",
      'Why: in the Spine community teams report that sharing and merging project files is hard because the format is noisy; a readable list of what really changed between two files is the part that does not need a server. The checkpoint of a file cannot be restored (its pictures are not loaded); open the file as a project to work on it.',
    ],
    ru: [
      'Сравнение с файлом проекта (Контрольные точки → кнопка со сравнением файлов или палитра команд): другая версия проекта, например копия коллеги или старое сохранение, читается без открытия, показывается позой под текущей и списком того, что добавлено, убрано и изменено (кости, слоты, скины, констрейнты, события, анимации с числом ключей). Вещи сопоставляются по id, так что это подходит для копий одного проекта. «Скопировать изменения» кладёт список в буфер обмена простым текстом для сообщения или ревью.',
      'Зачем: в сообществе Spine команды пишут, что делиться файлами проекта и сливать их трудно из-за шумного формата; читаемый список того, что реально изменилось между двумя файлами, это часть, которой не нужен сервер. Контрольную точку из файла восстановить нельзя (её картинки не загружены); чтобы работать с файлом, откройте его как проект.',
    ],
  },
  {
    version: '0.58',
    date: '2026-11-19',
    en: [
      'Review comments, with no server and no account: the player page (Export → Save player page) now has a Comment button. A reviewer puts a note on a moment of an animation, with their name, and downloads a small file; File → Import review comments turns the notes into timeline markers with the author, the bone they point at and a Resolved mark (resolved ones fade). Importing the same file twice changes nothing; the file is read strictly (a limited number of notes, plain text only).',
      'Why: collaboration and feedback are among the most asked for things in the Spine and Rive communities, and neither has comments in the editor yet.',
    ],
    ru: [
      'Замечания рецензента без сервера и без аккаунтов: у страницы-плеера (Экспорт → Сохранить страницу-плеер) появилась кнопка Comment. Рецензент ставит заметку на момент анимации, подписывается и скачивает маленький файл; «Файл → Импорт замечаний рецензента» превращает заметки в маркеры таймлайна с автором, костью, на которую они указывают, и отметкой «Решено» (решённые бледнеют). Повторный импорт того же файла ничего не меняет; файл читается строго (ограниченное число заметок, только простой текст).',
      'Зачем: совместная работа и обратная связь входят в самое частое, о чём просят в сообществах Spine и Rive, а комментариев в редакторе нет ни у того, ни у другого.',
    ],
  },
  {
    version: '0.57',
    date: '2026-11-19',
    en: [
      'Duplicate and Mirror now bring the constraints that act on the copied bones (IK, transform, path, physics): a constraint whose constrained bones are all copied is copied onto the copies. Its target stays the original bone unless that was copied too, and a mirrored IK flips its bend direction.',
      'Clipping and bounding box: a Reset shape button puts the polygon back to a square around its bone (weights and deform keys of the old shape go).',
      "Commands: Flip scale X / Y of the selected bones, and Move the bone up / down among its siblings (Spine's Bone Order Up / Down; the descendants go along).",
      'Fixes: deform keys of a skin no longer go stale when a skin picture replaces an attachment, or when the source of a linked mesh that takes its deform changes shape.',
    ],
    ru: [
      '«Дублировать» и «Отразить» теперь берут с собой констрейнты, которые действуют на копируемые кости (IK, transform, path, physics): констрейнт, у которого все ограничиваемые кости скопированы, копируется на копии. Его цель остаётся прежней костью, если её не копировали тоже, а у отражённого IK направление изгиба меняется.',
      'Clipping и bounding box: кнопка «Сбросить форму» возвращает многоугольник к квадрату вокруг его кости (веса и ключи деформации старой формы пропадают).',
      'Команды: «Отразить масштаб X / Y выбранных костей» и «Сдвинуть кость выше / ниже среди соседей» (Bone Order Up / Down в Spine; потомки идут следом).',
      'Исправления: ключи деформации скина больше не устаревают, когда картинка скина заменяет вложение или когда меняется форма источника связанного меша, который берёт его деформацию.',
    ],
  },
  {
    version: '0.56',
    date: '2026-11-19',
    en: [
      'From the Spine 4.3 changelog: Key Constrained (the Key constrained button in the Inspector, or the command palette) keys the pose a bone has after its constraints, IK or physics included, so that motion can be baked into ordinary keys at the playhead.',
      'Settings: New keys use the last chosen interpolation (smooth, linear or stepped, whichever you set last on a key).',
      'Skins: Merge into (the merge button of the Skins panel) copies the attachments of a skin into another one, with a say in replacing the ones that exist and in bringing the bones, constraints and animation keys along.',
      'File: Package project (ZIP) makes one archive with the project file and the pictures as files of their own.',
    ],
    ru: [
      'Из changelog Spine 4.3: «Ключ после констрейнтов» (кнопка в инспекторе или палитра команд) ставит ключи на позу, которую кость имеет после констрейнтов, IK и физики в том числе, так что движение запекается в обычные ключи под маркером.',
      'Настройки: «Новые ключи берут последнюю выбранную интерполяцию» (плавную, линейную или по кадрам, какую вы выбрали последней у ключа).',
      'Скины: «Слить в» (кнопка слияния в панели скинов) копирует вложения скина в другой, с выбором: заменять ли существующие и переносить ли кости, констрейнты и ключи анимаций.',
      'Файл: «Упаковать проект (ZIP)» делает один архив с файлом проекта и картинками отдельными файлами.',
    ],
  },
  {
    version: '0.55',
    date: '2026-11-19',
    en: [
      'Mesh: Triangle order (pick a triangle in the viewport, then move it first, earlier, later or last in the drawing order; where triangles overlap, the later one is on top, and the export keeps the order) and Outline only (only the hull is drawn and picked, the inner vertices and edges are out of the way).',
      'Timeline: a track filter (the funnel button): the kinds of tracks that show, a name to look for (words, * ?, or /regular expression/), and the selected bones and slots only. Keys between frames: Settings → Key time step sets the step the keys and the playhead snap to (whole frames, halves, quarters, tenths); the file stores seconds, so they export as they are.',
      "Metrics: what this pose costs to draw (draw calls by texture page, blend mode and clipping; pictures and triangles drawn; the triangles a clipping polygon cuts). Ghosting: motion arrows along the path of the selected bones' tips through the ghosts.",
      'Skins: Duplicate with options can point the copy at other pictures (this text in the picture names becomes that one, where such a picture exists).',
      'Export: Split colour keys writes an alpha or rgb timeline for a slot whose colour keys only change that part, as Spine does (JSON and binary). Import reads separate rgb and alpha timelines together, curves included, and a missing alpha value is 0 as in Spine.',
    ],
    ru: [
      'Меш: «Порядок треугольников» (выберите треугольник во вьюпорте и сдвиньте его первым, раньше, позже или последним в порядке отрисовки; где треугольники перекрываются, сверху тот, что позже, и экспорт сохраняет порядок) и «Только контур» (рисуется и выбирается только контур, внутренние вершины и рёбра не мешают).',
      'Таймлайн: фильтр дорожек (кнопка-воронка): какие виды дорожек видны, имя для поиска (слова, * ?, или /регулярное выражение/) и только выбранные кости и слоты. Ключи между кадрами: «Настройки → Шаг времени ключей» задаёт шаг, к которому привязываются ключи и маркер (целые кадры, половины, четверти, десятые); в файле хранятся секунды, так что они экспортируются как есть.',
      'Метрики: во что обходится отрисовка этой позы (вызовы отрисовки по странице текстуры, режиму смешивания и обрезке; нарисованные картинки и треугольники; треугольники, которые режет обрезающий полигон). Ghosting: стрелки движения вдоль пути кончиков выбранных костей через призраков.',
      'Скины: «Дублировать с параметрами» может направить копию на другие картинки (этот текст в именах картинок заменяется на тот, где такая картинка есть).',
      'Экспорт: «Раздельные ключи цвета» пишет дорожку alpha или rgb для слота, у которого ключи цвета меняют только эту часть, как делает Spine (JSON и binary). Импорт читает раздельные дорожки rgb и alpha вместе, вместе с кривыми, а пропущенное значение alpha — это 0, как в Spine.',
    ],
  },
  {
    version: '0.54',
    date: '2026-11-19',
    en: [
      'Ghosting (Settings → Viewport): ghosts at the keys around the playhead (of the selected bones, when some are selected) as well as every few frames; pictures, flat silhouettes or an x-ray drawn over the pose; a shift per ghost along X and Y that turns them into a trail; your own colours for before and after.',
      'Preview: layers. Play another animation over the main one with its own strength, additive or looping; a layer moves only what it keys. Hold previous keeps what the new animation does not key where the old one had it while the Preview crossfades.',
      'Animation tools: Block to previous / next (the selected keys of a timeline move together, their differences kept) and Store / Swap (set the values of some keys aside, trade them with the keys, trade back). Ctrl+Shift-drag a selected key in the dopesheet scales the time of the whole selection.',
      'Skins: Pin keeps a skin shown while you choose another one, and Duplicate with options takes a name and chooses what comes along (bones and constraints, animation keys, linked meshes). PgUp / PgDn go back and forward through the selections you made.',
      'Find and replace also renames pictures (the attachments that show them follow) and can be limited to the selection or the chosen skin.',
      'View: Snap to whole pixels, an Outline map (the whole skeleton in a corner with a frame round what the viewport shows; click or drag to move there), Pixel grid and Show FPS in Settings, and a Name on screen switch for a single bone. Numeric fields also read × ÷ and the true minus.',
    ],
    ru: [
      'Ghosting (Настройки → Viewport): призраки на ключах вокруг маркера (выбранных костей, если они выбраны) и через несколько кадров; картинки, плоский силуэт или рентген поверх позы; сдвиг каждого призрака по X и Y, из которого получается шлейф; свои цвета для «до» и «после».',
      'Preview: слои. Поверх основной анимации играет ещё одна, со своей силой, additive или повтором; слой двигает только то, что в нём заключено ключами. «Удерживать предыдущую» оставляет то, чего нет в ключах новой анимации, как было в старой, пока идёт переход в Preview.',
      'Инструменты анимации: «Блок к предыдущему / следующему» (выбранные ключи дорожки двигаются вместе, разница между ними сохраняется) и «Запомнить» / «Поменять» (отложить значения ключей, обменять их с ключами, обменять обратно). Ctrl+Shift и перетащить выбранный ключ в дорожках: масштаб времени всего выделения.',
      'Скины: булавка оставляет скин на экране, пока вы выбираете другой, а «Дублировать с параметрами» принимает имя и выбор того, что берётся с собой (кости и констрейнты, ключи анимаций, связанные меши). PgUp / PgDn: назад и вперёд по сделанным выделениям.',
      '«Найти и заменить» переименовывает и картинки (вложения, которые их показывают, идут следом) и работает только по выделенному или только по выбранному скину.',
      'Вид: привязка к целым пикселям, «Карта-обзор» (весь скелет в углу с рамкой видимой части, клик или перетаскивание двигает вид), «Пиксельная сетка» и «Показывать FPS» в настройках, «Имя на экране» для одной кости. Числовые поля понимают также × ÷ и настоящий минус.',
    ],
  },
  {
    version: '0.53',
    date: '2026-11-19',
    en: [
      "A table of Spine's features against ours (docs/SPINE_PARITY.md), made from Spine's own user guide, and the gaps it showed that were worth closing.",
      'Find and replace in names (the arrows button next to the Hierarchy filter): bones, slots, skins, events, constraints and animations, with regular expressions, match case and a count of what would change; one step of the history. The filter itself takes * ? wildcards and /regex/.',
      "Graph: an Automatic curve (smooth through the neighbours, never past a key's value) and a Flat one in the interpolation menu. Animation tools: Favor (move the selected keys toward the key before, after, the mean of both, or the setup pose) and Scale time (stretch the selected keys in time).",
      "Transform constraint: Match to current pose sets the offsets so the constraint changes nothing in the Setup pose. Setup mode: Keep children and Keep images (Spine's Compensation) in the bone's Transform section. Playback: By frames shows the pose at the start of each frame.",
      'Export: premultiplied alpha pages, square pages, sizes in multiples of four, identical pictures sharing one place (alias), clean up animations on export. Animation tab: APNG and JPEG frames. The atlas options work in the command line too.',
      'Import: Import Spine data as a new skeleton (into the open project), Unpack an atlas into pictures (trimmed borders and turned regions restored), and the command line gets import, unpack and clean. Metrics: timelines, clipping polygons and the area of the textures.',
    ],
    ru: [
      'Таблица функций Spine и наших (docs/SPINE_PARITY.md), составленная по руководству самого Spine, и пробелы из неё, которые стоило закрыть.',
      'Найти и заменить в именах (кнопка со стрелками рядом с фильтром иерархии): кости, слоты, скины, события, констрейнты и анимации, с регулярными выражениями, регистром и счётчиком того, что изменится; один шаг истории. Сам фильтр понимает шаблоны * ? и /regex/.',
      'График: автоматическая кривая (плавно через соседей, не выходя за значение ключа) и плоская в меню интерполяции. Инструменты анимации: Смещение к соседям (выбранные ключи к ключу до, после, середине двух или позе Setup) и Масштаб времени (растянуть выбранные ключи по времени).',
      'Transform-констрейнт: «Подогнать под текущую позу» подбирает смещения, чтобы констрейнт ничего не менял в позе Setup. Режим Setup: «Дети на месте» и «Картинки на месте» (компенсация, как в Spine) в разделе Transform кости. Воспроизведение: «По кадрам» показывает позу на начало каждого кадра.',
      'Экспорт: страницы с предумноженной альфой, квадратные страницы, размеры кратные четырём, одинаковые картинки одним местом (alias), очистка анимаций при экспорте. Вкладка анимации: APNG и кадры JPEG. Параметры атласа работают и в командной строке.',
      'Импорт: «Импорт данных Spine новым скелетом» (в открытый проект), «Распаковать атлас в картинки» (обрезанные поля и повёрнутые регионы возвращаются) и в командной строке import, unpack и clean. Метрики: таймлайны, клиппинг-полигоны и площадь текстур.',
    ],
  },
  {
    version: '0.52',
    date: '2026-11-19',
    en: [
      "Layer on top (Animation tools window): pick a second animation, a strength and whether it repeats, and the sum (a breath over a walk) is baked into a new animation, the way a second track with additive blending adds on in a game runtime. The layer moves its own bones, the rest of the first animation stays. Checked against the official runtime's additive track.",
      'Fade pictures (Animation tools window): where an animation changes the picture of the selected slot (a mouth, an eye), the new picture fades in while the old one fades out instead of a hard cut. No runtime fades one attachment into another, so a second slot ("<slot> fade"), drawn right above, carries the old pictures and fades out; both are keyed in the animation and export like any slot.',
      'Save player page (Export window): one HTML file with the skeleton, its pictures and a small player inside. It opens offline in any browser, with animation and skin pickers, play and pause, a time slider, zoom and pan, and a light or dark background. For sending a result to a client.',
    ],
    ru: [
      'Слой сверху (окно «Инструменты анимации»): выбери вторую анимацию, силу и повторять ли её, и сумма (дыхание поверх ходьбы) запечётся в новую анимацию, как вторая дорожка с аддитивным смешиванием складывается в игровом рантайме. Слой двигает свои кости, остальное в первой анимации остаётся. Проверено на аддитивной дорожке официального рантайма.',
      'Плавная смена картинок (окно «Инструменты анимации»): где анимация меняет картинку выбранного слота (рот, глаз), новая картинка проявляется, а старая гаснет, вместо резкой смены. Ни один рантайм не растворяет одно вложение в другое, поэтому старые картинки несёт второй слот («<слот> fade»), нарисованный сразу выше, и гаснет; оба слота с ключами в анимации и экспортируются как обычные.',
      'Сохранить страницу-плеер (окно экспорта): один HTML-файл со скелетом, картинками и небольшим плеером внутри. Открывается без интернета в любом браузере: выбор анимации и скина, пуск и пауза, ползунок времени, масштаб и сдвиг, светлый или тёмный фон. Чтобы отправить результат заказчику.',
    ],
  },
  {
    version: '0.51',
    date: '2026-11-19',
    en: [
      "Temporary pivot for the rotate tool: with the rotate tool chosen, the Pivot section of the bone inspector sets a point the selected bones turn about instead of their own origin (pick it in the viewport, type it, or put it on the bone's origin or tip). The bone's origin goes round the point, so a turn about a wrist or a neck is one drag; in Animate mode it keys the rotation and the position together. A ring with a cross marks the pivot while the rotate tool is on.",
      'Reference video (Animation tools window): load a filmed take and it is drawn over the scene, faded (opacity, size, position, and an offset against the animation time, or Start at playhead), kept in step with the playhead: moved to the frame when paused, played along while the animation plays. For tracing the motion. The video stays in the tab: nothing is saved or exported.',
    ],
    ru: [
      'Временный центр вращения для инструмента вращения: при выбранном вращении раздел «Центр вращения» в инспекторе кости задаёт точку, вокруг которой поворачиваются выбранные кости, а не вокруг их начала (указать во вьюпорте, ввести числами или поставить в начало или конец кости). Начало кости идёт по кругу вокруг точки, так что поворот вокруг запястья или шеи делается одним движением; в режиме Animate ключи ставятся и на поворот, и на позицию. Пока включено вращение, центр отмечен кольцом с крестом.',
      'Опорное видео (окно «Инструменты анимации»): загрузи снятый дубль, и он рисуется поверх сцены полупрозрачным (непрозрачность, размер, позиция и сдвиг относительно времени анимации, или «Начать с playhead») в такт с playhead: на паузе перематывается на кадр, при воспроизведении анимации играет вместе с ней. Чтобы обводить движение. Видео остаётся во вкладке: ничего не сохраняется и не экспортируется.',
    ],
  },
  {
    version: '0.50',
    date: '2026-11-19',
    en: [
      'Sprite sheets: the grid button on a picture in the Images window cuts it into numbered pictures (Cut by columns and rows or by cell size, with a margin and spacing, numbered along the rows or down the columns). The cells at the end of the sheet that are empty are left out, a preview shows the grid, and the frames can go on the scene as one slot that plays them, looped at the frame rate you give from the start of the open animation. All of it is one step of the history.',
      'Animated GIF import (the film button in the Images window; needs a browser that can read GIF frames, such as Chrome or Edge): every frame becomes a picture, the sequence loops at the average delay of the frames.',
      'Sequence thumbnails on the dopesheet: between the keys of a sequence row the pictures that play are drawn in the frame cells (with the frame number when there is room), so you can see which frame is where. It follows the same rules as the player, modes and delays included.',
    ],
    ru: [
      'Листы спрайтов: кнопка с сеткой на картинке в окне «Картинки» режет её на пронумерованные картинки (по столбцам и строкам или по размеру ячейки, с полями и интервалом, нумерация по строкам или по столбцам). Пустые ячейки в конце листа не берутся, предпросмотр показывает сетку, а кадры можно положить на сцену одним слотом, который их проигрывает по кругу с заданной частотой с начала открытой анимации. Всё это один шаг истории.',
      'Импорт анимированного GIF (кнопка с плёнкой в окне «Картинки»; нужен браузер, умеющий читать кадры GIF, например Chrome или Edge): каждый кадр становится картинкой, последовательность зацикливается со средней задержкой кадров.',
      'Миниатюры последовательностей на таймлайне: между ключами строки последовательности в клетках кадров рисуются играющие картинки (с номером кадра, когда хватает места), так что видно, какой кадр где. Работает по тем же правилам, что и плеер, с режимами и задержками.',
    ],
  },
  {
    version: '0.49',
    date: '2026-11-19',
    en: [
      "Skin from pictures (Skins window → the folder button): pictures named like an attachment with a prefix in front (arctic/head, arctic-head, arctic_head) become the pictures of that attachment in the skin arctic. A region gets a region with the picture's size, a mesh gets a linked mesh that keeps its shape, weights and deform. The window suggests the prefixes your pictures make up, or type one and see how many attachments get a picture. A skin of that name that already exists gets the new pictures added; it is one step of the history. A mesh whose new picture has another size is reported.",
    ],
    ru: [
      'Скин из картинок (окно «Скины» → кнопка с папкой): картинки, названные как вложение, с префиксом впереди (arctic/head, arctic-head, arctic_head), становятся картинками этого вложения в скине arctic. Региону достаётся регион с размером картинки, сетке — linked mesh, который сохраняет форму, веса и деформацию. Окно предлагает префиксы, из которых складываются твои картинки, или введи свой и посмотри, сколько вложений получат картинку. Скин с таким именем, если он уже есть, пополняется новыми картинками; это один шаг истории. Если у сетки новая картинка другого размера, об этом скажут.',
    ],
  },
  {
    version: '0.48',
    date: '2026-11-19',
    en: [
      'Undo now brings back the old pixels of a replaced picture (Replace image, Update from PSD), not only its size; Redo puts the new ones back, and the History window jumps through such steps the same way. A same-size repaint is a step of its own.',
      'Weight brush Strength curve: Even (the slider as before), Fine (10% paints 1%, for careful touch-ups) or Bold (10% paints about 32%, for quick strong strokes).',
    ],
    ru: [
      'Undo теперь возвращает старые пиксели заменённой картинки (Replace image, «Обновить из PSD»), а не только её размер; Redo возвращает новые, а окно History переходит по таким шагам так же. Перекраска того же размера — отдельный шаг.',
      '«Кривая силы» кисти весов: «Ровная» (ползунок как раньше), «Тонкая» (10% красит на 1%, для аккуратных правок) или «Смелая» (10% красит примерно на 32%, для быстрых сильных мазков).',
    ],
  },
  {
    version: '0.47',
    date: '2026-11-19',
    en: [
      "Checkpoints (History window → Checkpoints): mark the skeleton as it is now, then compare. A violet ghost of the checkpoint's pose (the same animation at the same time) is drawn under the current one, and the list shows what changed since: bones, slots, skins, constraints, events and animations added, removed or changed, with the number of keys. One click goes back to a checkpoint (one step of the history, so Undo brings the work back). They are kept until the project is closed.",
      'Constraint effects (Inspector, for a bone that a constraint moves): the pose the animation gives the bone, what each IK, transform or path constraint adds to it in the order they run (turn, move, scale, shear), and the result. Physics is left out: it depends on the time before.',
    ],
    ru: [
      'Контрольные точки (окно History → «Контрольные точки»): запомни скелет таким, какой он сейчас, и сравнивай. Фиолетовый призрак позы точки (та же анимация в то же время) рисуется под текущей, а список показывает, что изменилось: добавленные, удалённые и изменённые кости, слоты, скины, констрейнты, события и анимации, с числом ключей. Один клик возвращает к точке (один шаг истории, Undo возвращает работу назад). Живут, пока проект открыт.',
      'Действие констрейнтов (Inspector, для кости, которую двигает констрейнт): поза из анимации, что добавляет каждый IK, transform или path в порядке работы (поворот, сдвиг, масштаб, скос) и итог. Физика не показана: она зависит от предыдущего времени.',
    ],
  },
  {
    version: '0.46',
    date: '2026-11-19',
    en: [
      "Constraint arrows (View → Constraint arrows): an arrow from what drives each constraint (an IK target, a transform source, a slider's bone) to every bone it moves, labelled with the name and strength; paths and physics get a ring on their bones. Select a bone or a constraint and only the ones that touch it stay bright, the rest fade.",
      'Weight brush Fade: soft (as before), linear, smooth or sharp falloff inside the feather zone, for a gentler or harder paint.',
      'Soft selection also works for the vertices of clipping polygons and bounding boxes; the Soft controls moved into one place that both inspectors share.',
    ],
    ru: [
      'Стрелки констрейнтов (View → «Стрелки констрейнтов»): стрелка от того, что ведёт констрейнт (цель IK, источник transform, кость слайдера), к каждой кости, которую он двигает, с именем и силой; у путей и физики кольцо на костях. Выберите кость или констрейнт, и ярко остаются только те, что с ней связаны, остальные тускнеют.',
      'Спад кисти весов («Спад кисти»): мягкий (как раньше), линейный, сглаженный или резкий спад внутри зоны растушёвки, для более мягкой или жёсткой покраски.',
      'Мягкое выделение работает и для вершин clipping-полигонов и bounding box; элементы «Мягко» собраны в одном месте, общем для обоих инспекторов.',
    ],
  },
  {
    version: '0.45',
    date: '2026-11-19',
    en: [
      'Soft selection (Mesh tool → Soft): dragging the selected vertices also pulls the ones near them, less and less with the distance. Radius and falloff (smooth, linear, sharp) are in the Inspector; the vertices that follow are tinted by how much. It works in Setup and for deform keys in Animate; one drag is one undo step.',
      "Skins together: the layers button on a skin row of the Skins window shows that skin together with the chosen one, as the runtime does with several skins worn at once (a later skin replaces the earlier one's attachment, the bones and constraints of all of them are active). A preview only: the export does not change. Deform keys go to the skin the mesh comes from.",
      'Bake: when a path constraint has no path on some frames (the slot shows a mesh, nothing, or an attachment key turns it off), the bake says which one: its bones keep the pose of the last frame that solved, the same as in the official runtime, and a local pose cannot carry that.',
    ],
    ru: [
      'Мягкое выделение (инструмент «Меш» → «Мягко»): выбранные вершины тянут за собой соседние, чем дальше, тем слабее. Радиус и спад (плавный, линейный, резкий) задаются в Инспекторе; вершины, которые следуют, подкрашены по силе. Работает в Setup и для ключей деформации в Animate; одно перетаскивание — один шаг отмены.',
      'Скины вместе: кнопка со слоями в строке скина в окне Skins показывает этот скин вместе с выбранным, как рантайм с несколькими надетыми скинами (вложение позднего скина заменяет раннее, кости и констрейнты всех активны). Только предпросмотр: экспорт не меняется. Ключи деформации пишутся в тот скин, которому принадлежит сетка.',
      'Запекание: если у констрейнта пути на части кадров нет пути (в слоте сетка, ничего или ключ вложения его выключает), запекание называет такой констрейнт: его кости остаются в позе последнего решённого кадра, как в официальном рантайме, а локальная поза этого передать не может.',
    ],
  },
  {
    version: '0.44',
    date: '2026-11-19',
    en: [
      'Constraint presets: the Presets menu at the top of every constraint keeps its settings under a name (the spring of a physics constraint, the stiffness of an IK, the modes of a path) and puts them on another constraint of the same kind in one undo step. What the constraint points at is not kept, so a preset fits any rig. The library is yours, in the browser, for every project.',
      'Selection sets: under the Hierarchy filter, + keeps the selected bones under a name; one click selects them again, Shift+click adds them or takes them out. They are saved with the skeleton and are not exported. A rename does not break a set.',
      'Micro-move: Alt + the arrow keys move the selected bones by a unit in the scene (Shift: ten); with keys selected in the timeline, ← → move the keys by a frame and ↑ ↓ change their values.',
      'Saved layouts: Windows → Save layout as… keeps the open windows and their sizes under a name; the saved layouts are in the Windows menu and the command palette.',
      'Reference (Animation tools): another animation, or the setup pose, drawn faded green under the pose you edit, at the same time, to compare a frame with it. Nothing of it is saved or exported.',
    ],
    ru: [
      'Пресеты констрейнтов: меню «Пресеты» вверху каждого констрейнта сохраняет его настройки под именем (пружину физики, жёсткость IK, режимы path) и накладывает их на другой констрейнт того же вида одним шагом отмены. На что указывает констрейнт, в пресет не входит, поэтому пресет подходит к любому ригу. Библиотека твоя, в браузере, общая для всех проектов.',
      'Наборы выделения: под фильтром иерархии кнопка + запоминает выбранные кости под именем; один клик выбирает их снова, Shift+клик добавляет их или убирает. Хранятся вместе со скелетом, в экспорт не попадают. Переименование кости набор не ломает.',
      'Микро-сдвиг: Alt + стрелки двигают выбранные кости на единицу по сцене (Shift: на десять); если в таймлайне выбраны ключи, ← → двигают ключи на кадр, а ↑ ↓ меняют их значения.',
      'Сохранённые раскладки: Windows → «Сохранить раскладку как…» запоминает открытые окна и их размеры под именем; сохранённые раскладки есть в меню Windows и в палитре команд.',
      'Эталон (Animation tools): другая анимация или поза Setup рисуется бледно-зелёным под редактируемой позой, в то же время, чтобы сравнить кадр с ней. Ничего из этого не сохраняется и не экспортируется.',
    ],
  },
  {
    version: '0.43',
    date: '2026-11-19',
    en: [
      'Rotation limit: a bone can be kept inside a sector of angles (Inspector → Rotation limit). The sector is drawn in the scene; the bone follows a control bone and stops at the ends of the sector. It is a Spine 4.3 transform constraint with a clamp, so it exports and plays in every runtime. Rotating or keying the limited bone goes to the control bone, so dragging past the sector keeps turning the control and the bone follows as soon as it is back.',
      'Chain curve (Inspector, for a tail or a spine): spread one physics value (strength, damping, inertia, mass, mix, wind, gravity) over the bones of a chain along a curve instead of typing it bone by bone. Missing physics constraints are created.',
      'Tween (Animation tools): a slider that puts the selected bones between the keys before and after the playhead (0% previous key, 100% next, beyond that overshoots) and keys them there; one drag is one undo step.',
      'Mute: a speaker button on a bone, slot or constraint row of the timeline plays the animation without those keys, to compare with and without. The keys stay and the export does not change. The zoom button falls back to the loop range when no keys are selected. Pasting a key that repeats the value already there keeps the curve that was drawn on it.',
    ],
    ru: [
      'Предел поворота: кость можно удержать в секторе углов (Инспектор → «Предел поворота»). Сектор рисуется на сцене; кость следует за костью-управлением и останавливается на краях сектора. Это transform-констрейнт Spine 4.3 с clamp, поэтому он экспортируется и работает в любом рантайме. Вращение и ключи ограниченной кости уходят в кость-управление: если тянуть за сектор, управление продолжает крутиться, а кость следует, как только оно вернулось.',
      'Кривая по цепочке (Инспектор, для хвоста или позвоночника): одно значение физики (сила, затухание, инерция, масса, mix, ветер, гравитация) раскладывается по костям цепочки вдоль кривой, а не вводится по одной кости. Недостающие физические констрейнты создаются.',
      'Tween (Animation tools): ползунок ставит выбранные кости между ключами до и после текущего кадра (0% предыдущий ключ, 100% следующий, дальше — перелёт) и ключует их там; одно перетаскивание — один шаг отмены.',
      'Mute: кнопка с динамиком на строке кости, слота или констрейнта в таймлайне проигрывает анимацию без этих ключей, чтобы сравнить «с» и «без». Ключи остаются, экспорт не меняется. Кнопка масштаба без выбранных ключей берёт диапазон цикла. Вставка ключа, повторяющего значение, которое уже там, оставляет нарисованную на нём кривую.',
    ],
  },
  {
    version: '0.42',
    date: '2026-11-19',
    en: [
      'Timeline markers: flags with a name, a colour and a note (Animation tools → Markers, or the command palette). They show on the ruler and as a faint line down the keys; double-click one to edit it. Split at markers cuts the animation into one clip per stretch, each clip moving exactly like the original did there.',
      "Animation tools: Wiggle (random noise on the selected keys' timelines, with a seed so it is repeatable), Mirror a half cycle (animate one step, get the whole cycle with left and right swapped, as a new animation), Foot slide (finds where a planted foot drags along the ground), Hide bones without keys.",
      'Split bone can now share the weights of the meshes that follow the bone: each vertex goes to the part it lies on, or blends smoothly around each cut, and the deform keys follow. Splitting the first bone of an IK chain nested is refused with a note (the second bone would leave the first one).',
      'Export: the mix table (crossfade times between animations) is written as <name>.mixes.json next to the skeleton, in the editor and with the command line (--no-mixes leaves it out). The export dialog can copy its settings as text.',
      "Draw order list: slots of a draw order folder that sit next to each other are grouped under the folder's name and can be folded. Dropping a folder of numbered pictures (frame01 …) on the scene makes one slot with a sequence for each series. Update from PSD ignores the shift a bigger canvas gives every layer. The event waveform shows on the events row of the dopesheet when the sound is loaded. The Preview can open in a window of its own.",
    ],
    ru: [
      'Маркеры на таймлайне: флажки с именем, цветом и заметкой (Animation tools → Markers или палитра команд). Видны на линейке и тонкой линией сквозь ключи; двойной щелчок открывает правку. «Разрезать по маркерам» делает клип на каждый отрезок, и каждый клип двигается точно как оригинал на этом отрезке.',
      'Animation tools: «Дрожь» (случайный шум на таймлайнах выбранных ключей, с зерном, чтобы повторялось), «Зеркало полуцикла» (анимируете один шаг, получаете весь цикл с поменянными левым и правым, новой анимацией), «Скольжение стопы» (находит, где стопа на земле ползёт), «Скрыть кости без ключей».',
      'Разрезание кости теперь может поделить веса мешей, которые за ней следуют: каждая вершина уходит в часть, на которой лежит, или плавно делится у каждого разреза, ключи деформации идут следом. Разрезать цепочкой первую кость IK-цепи нельзя: об этом говорится в заметке (вторая кость ушла бы из-под первой).',
      'Экспорт: таблица переходов (времена перехода между анимациями) пишется файлом <имя>.mixes.json рядом со скелетом, в редакторе и в командной строке (--no-mixes отключает). В диалоге экспорта настройки можно скопировать текстом.',
      'Список порядка отрисовки: слоты папки порядка отрисовки, идущие подряд, собраны под именем папки и сворачиваются. Папка пронумерованных картинок (frame01 …), брошенная на сцену, даёт один слот с последовательностью на каждую серию. «Обновить из PSD» не считает правкой сдвиг, который расширенный холст даёт всем слоям. Волна звука события видна на ряду событий в доупшите, когда звук загружен. Просмотр можно открыть в отдельном окне.',
    ],
  },
  {
    version: '0.41',
    date: '2026-11-18',
    en: [
      "Split X / Y keys (Spine's translateX / translateY, scaleX / scaleY, shearX / shearY): in Animate mode the Inspector has a Split X / Y switch for position, scale and shear (also in the timeline menu and the command palette). A split channel keeps its keys but has one timeline per axis, each with its own key times and curves; auto-key and the Key buttons then key only the axis you change. Merging joins the axes again. The solver, JSON and binary export and import all handle them and are checked against the official runtime; before, a Spine file with split timelines lost the second axis on import.",
      'Key dialog: double-click a key in the dopesheet (or right-click → Edit key…, or the command palette) to type its frame, its values, its interpolation and the bezier handles of its curve.',
    ],
    ru: [
      'Разделённые ключи X / Y (translateX / translateY, scaleX / scaleY, shearX / shearY в Spine): в режиме Animate в Инспекторе есть переключатель «Разделить X / Y» для позиции, масштаба и сдвига (а также в меню таймлайна и в палитре команд). Разделённый канал сохраняет ключи, но у каждой оси свой таймлайн со своими временами и кривыми; автоключ и кнопки ключей ставят ключ только на ось, которую вы меняете. «Склеить» объединяет оси обратно. Солвер, экспорт и импорт JSON и binary поддерживают такие таймлайны и сверены с официальным рантаймом; раньше файл Spine с разделёнными таймлайнами терял вторую ось при импорте.',
      'Диалог ключа: двойной щелчок по ключу в доупшите (или правая кнопка → «Править ключ…», или палитра команд) — можно ввести кадр, значения, интерполяцию и маркеры безье кривой.',
    ],
  },
  {
    version: '0.40',
    date: '2026-11-18',
    en: [
      'Several skeletons in one project: at the top of the Hierarchy pick the skeleton to edit, add an empty one, duplicate or delete the edited one. The pictures are shared (an image another skeleton shows counts as used, a rename follows into all of them); the pose library and the mix table belong to each skeleton. Export has a Skeleton choice (the edited one, any, or all in one ZIP, a folder each); the command line writes a file for every skeleton (--skeleton picks one).',
      'Key Edited (K): keys only the channels you changed since the last key, for example only the rotation after you turned a bone; with nothing pending it keys everything of the selected bones. Ctrl+Shift+L always keys all channels (Key Shown in Spine).',
      'Floating windows (Windows → Floating: Slot color, Mesh tools, Weights): the same controls as in the Inspector in windows that hover over the viewport, can be dragged and stay where you leave them. While one is open the Inspector does not repeat its controls.',
      'Backups (History window, Backups): the editor keeps copies of the project in the browser, every five minutes of work, before you open another file or start a new project, and when you press Back up now. Restore brings one back (what was open is backed up first), the trash button deletes one.',
      'Command line: export --atlas packs the pictures into the atlas and PNG pages with the same packer as the editor (--max-size, --padding, --no-pot, --trim, --rotate, --filter, and --scale for smaller pictures). PNG only; other picture formats are left out with a note.',
      'Fixed: the atlas packer could make a page bigger than the page size limit when there were many pictures; the deform keys of a linked mesh that has its own deform no longer break when the weights of its source change.',
    ],
    ru: [
      'Несколько скелетов в одном проекте: вверху иерархии выберите скелет для правки, добавьте пустой, дублируйте или удалите редактируемый. Картинки общие (картинка, которую показывает другой скелет, считается используемой, переименование доходит до всех); библиотека поз и таблица переходов у каждого скелета свои. В экспорте есть выбор скелета (редактируемый, любой или все в одном ZIP, по папке на каждый); командная строка пишет файл для каждого скелета (--skeleton выбирает один).',
      'Key Edited (K): ключ только на те каналы, что вы изменили с прошлого ключа, например только на поворот после поворота кости; когда ничего не менялось, ключует всё у выбранных костей. Ctrl+Shift+L всегда ключует все каналы (Key Shown в Spine).',
      'Плавающие окна (Окна → Плавающее: цвет слота, инструменты меша, веса): те же элементы, что в Инспекторе, в окнах над вьюпортом; их можно перетаскивать, и они остаются там, где вы их оставили. Пока окно открыто, Инспектор не повторяет его элементы.',
      'Резервные копии (окно History, раздел Backups): редактор хранит копии проекта в браузере, каждые пять минут работы, перед открытием другого файла или новым проектом и по кнопке «Сделать копию сейчас». «Вернуть» возвращает копию (открытое сперва тоже сохраняется), корзина удаляет копию.',
      'Командная строка: export --atlas пакует картинки в атлас и страницы PNG тем же упаковщиком, что и редактор (--max-size, --padding, --no-pot, --trim, --rotate, --filter, а --scale даёт уменьшенные картинки). Только PNG; другие форматы картинок остаются за атласом с пометкой.',
      'Исправлено: упаковщик атласа мог сделать страницу больше предельного размера, когда картинок много; ключи деформации связанного меша со своей деформацией больше не ломаются, когда меняются веса его источника.',
    ],
  },
  {
    version: '0.39',
    date: '2026-11-17',
    en: [
      'Draw order folders (new in Spine 4.3): put slots into a folder (Inspector, slot, Folder) and the draw order of the folder is keyed on its own. In Animate mode, dragging a slot of a folder in the Hierarchy keys the folder only: its slots swap places among the seats they hold, the other slots stay where they are. Every folder with keys gets its own row in the dopesheet. Export (JSON and binary) and import of Spine files with draw order folders work and are checked against the official runtime; before, imported folder timelines were dropped.',
    ],
    ru: [
      'Папки порядка отрисовки (новое в Spine 4.3): положите слоты в папку (Инспектор, слот, «Папка»), и порядок отрисовки папки ключуется отдельно. В режиме Animate перетаскивание слота папки в иерархии ставит ключ только папки: её слоты меняются местами на тех местах, что они занимают, остальные слоты остаются на месте. У каждой папки с ключами свой ряд в доупшите. Экспорт (JSON и binary) и импорт файлов Spine с такими папками работают и сверены с официальным рантаймом; раньше импортированные таймлайны папок отбрасывались.',
    ],
  },
  {
    version: '0.38',
    date: '2026-11-17',
    en: [
      'Command line: `npm run cli -- export project.bone2d out/` writes the Spine 4.3 skeleton data (JSON or binary, scale, pretty, without editor-only data) and the pictures of the project without opening the editor, for a build step or CI; `info` counts what a project holds, `check` lists what is damaged (exit code 1). The atlas is still packed by the editor.',
    ],
    ru: [
      'Командная строка: `npm run cli -- export project.bone2d out/` пишет данные скелета Spine 4.3 (JSON или binary, масштаб, с отступами, без данных только для редактора) и картинки проекта, не открывая редактор, для шага сборки или CI; `info` считает, что в проекте, `check` перечисляет повреждения (код выхода 1). Атлас по-прежнему пакует редактор.',
    ],
  },
  {
    version: '0.37',
    date: '2026-11-17',
    en: [
      'Preview window (Windows → Preview): a small view of its own that plays an animation the way a game would. Choose an animation, loop, speed, pause; when you change to another animation the bones crossfade over the mix time. The mix table sits right there: a default time and times for single pairs of animations (saved in the project, not part of the Spine export, because Spine keeps it in the runtime code). Events that fire show up as chips; load sound files with the speaker button and an event plays the file with the name of its sound.',
      'Mesh view buttons (Inspector, Mesh, with the Edit mesh or Weights tool on): Wireframe hides the triangle edges, Dim darkens everything outside the mesh, Isolate hides it, Freeze lets you select vertices without dragging them.',
    ],
    ru: [
      'Окно «Просмотр» (Окна → Просмотр): отдельный маленький вид, который проигрывает анимацию так, как это сделает игра. Выбор анимации, повтор, скорость, пауза; при смене анимации кости плавно переходят за время перехода. Таблица переходов там же: время по умолчанию и время для отдельных пар анимаций (хранится в проекте, в экспорт Spine не попадает: Spine держит её в коде рантайма). Сработавшие события появляются метками; загрузите звуковые файлы кнопкой с динамиком, и событие проиграет файл с именем своего звука.',
      'Кнопки вида меша (Инспектор, «Сетка», при включённом инструменте сетки или весов): «Каркас» убирает рёбра треугольников, «Затемнить» затемняет всё вне меша, «Изолировать» скрывает его, «Заморозить» позволяет выделять вершины, не сдвигая их.',
    ],
  },
  {
    version: '0.36',
    date: '2026-11-17',
    en: [
      'Mesh edges like in Spine: draw an edge between two vertices (Ctrl+drag from one vertex to another with the mesh tool, or select two vertices and press Edge in the Mesh section; do it again to remove it) and the triangulation never crosses it, so you decide how the mesh bends. Manual edges are orange, the outline is cyan. The outline itself is now always kept as edges, so a concave outline (an L, a tail) no longer gets triangles that cut across it. The edges are saved with the project and written to the JSON and binary export as nonessential data (edges of imported Spine files are not used: the format does not say how their indices count). Vertex edits renumber the edges; Retriangulate and Clear edges rebuild the triangles.',
    ],
    ru: [
      'Рёбра меша, как в Spine: проведите ребро между двумя вершинами (Ctrl+перетаскивание от вершины к вершине инструментом меша, либо выберите две вершины и нажмите «Ребро» в разделе «Меш»; ещё раз — ребро убирается), и триангуляция его никогда не пересекает, так что вы сами решаете, как сгибается меш. Ребра, проведённые вручную, оранжевые, контур — голубой. Сам контур теперь всегда остаётся рёбрами, поэтому у вогнутого контура (буква Г, хвост) больше не появляются треугольники, режущие его насквозь. Рёбра сохраняются в проекте и пишутся в JSON и бинарный экспорт как необязательные данные (рёбра импортируемых файлов Spine не используются: формат не говорит, как считаются их индексы). Правки вершин перенумеровывают рёбра; «Перетриангулировать» и «Очистить» пересобирают треугольники.',
    ],
  },
  {
    version: '0.35',
    date: '2026-11-17',
    en: [
      'Weights: the list of the bones a mesh follows (Inspector, Weights) shows each bone with its colour, the Lock toggle and a new Remove button. Remove makes the mesh stop following that bone: its weight goes to the other bones of each vertex in proportion, a vertex that followed only that bone goes to the parent bone, the vertices stay where they are. One step in the history.',
    ],
    ru: [
      'Веса: список костей, за которыми следует сетка (Инспектор, «Веса»), показывает каждую кость с её цветом, переключателем замка и новой кнопкой «Убрать». «Убрать» делает так, что сетка перестаёт следовать за костью: её вес переходит другим костям каждой вершины пропорционально, вершина, которая следовала только за ней, переходит на родительскую кость, сами вершины остаются на месте. Один шаг в истории.',
    ],
  },
  {
    version: '0.34',
    date: '2026-11-17',
    en: [
      'Weights view like in Spine: Pies draws a pie chart of the weights on every vertex while the Weights tool is on (the selected vertices larger), Overlay fills the mesh with the colours of its bones instead of the brush-bone heat map, Selected limits the pies to the selected vertices and the vertices weighted to selected bones and shows the other bones black in the overlay. Every bone keeps its own colour.',
    ],
    ru: [
      'Просмотр весов, как в Spine: «Круги» рисуют на каждой вершине круговую диаграмму весов, пока включён инструмент весов (у выбранных вершин крупнее), «Заливка» красит сетку цветами её костей вместо тепловой карты кости кисти, «Выбранные» оставляют круги только у выбранных вершин и вершин с весом на выбранных костях, а в заливке остальные кости делают чёрными. У каждой кости свой постоянный цвет.',
    ],
  },
  {
    version: '0.33',
    date: '2026-11-17',
    en: [
      'Weights: Update bindings (after you moved bones in the setup pose, the stored bind positions are stale and weight edits shift the vertices; this makes the bind pose the pose the bones have now, the mesh does not move) and Weld (this mesh takes the weights of another weighted mesh where it lies over it, blended by position; both need the same two or more bones; Overlapping limits it to the vertices over the other mesh, All gives the vertices outside the weights of the nearest triangle). Both work on the selected vertices when some are selected, each is one step in the history.',
    ],
    ru: [
      'Веса: Обновить привязку (после сдвига костей в позе сборки сохранённые позиции привязки устаревают и правка весов сдвигает вершины; кнопка делает позой привязки текущую позу костей, сетка не двигается) и Слить (эта сетка берёт веса другой сетки там, где лежит поверх неё, с плавным переходом по положению; нужны те же две и более костей; «Перекрытие» — только вершины над другой сеткой, «Все» — вершинам снаружи достаются веса ближайшего треугольника). Оба работают на выбранных вершинах, если они выбраны, каждое — один шаг в истории.',
    ],
  },
  {
    version: '0.32',
    date: '2026-11-17',
    en: [
      'Weights: Lock (a locked bone keeps its weights while you paint, the others share what is left), Feather on the brush (how much of its size fades out: 100% from the centre, 0% a hard edge), Copy weights and Paste weights between the same number of selected vertices.',
      'Fixed: pasting two-colour (dark colour) keys onto a slot without a dark colour left the curve of the dark channels in the plain colour key; the document then needed repair. Found by the fuzz test.',
    ],
    ru: [
      'Веса: Замок (кость с замком сохраняет свои веса при рисовании, остальные делят то, что осталось), Растушёвка кисти (какая часть размера затухает: 100% — от центра, 0% — жёсткий край), Копировать и Вставить веса между одинаковым числом выбранных вершин.',
      'Исправлено: вставка ключей двух цветов (с тёмным цветом) на слот без тёмного цвета оставляла в обычном ключе кривую тёмных каналов, и документ потом требовал ремонта. Нашёл фаззер.',
    ],
  },
  {
    version: '0.31',
    date: '2026-11-17',
    en: [
      'Weights, closer to Spine: Auto, Smooth and Prune now work only on the selected vertices when some are selected (select them with the mesh tool, M; with none selected they work on the whole mesh). Prune has its own settings: the most bones a vertex may keep and the weight below which an influence is removed. New Swap: two bones exchange their weights on the selected vertices or the whole mesh, the vertices stay where they are. Each is one step in the history.',
    ],
    ru: [
      'Веса, ближе к Spine: Авто, Сглаживание и Очистка теперь работают только на выбранных вершинах, если они выбраны (выбираются инструментом сетки, M; без выбора — на всей сетке). У Очистки появились настройки: сколько костей может остаться у вершины и ниже какого веса влияние убирается. Новое: Обмен — две кости меняются весами на выбранных вершинах или на всей сетке, вершины остаются на месте. Каждое действие — один шаг в истории.',
    ],
  },
  {
    version: '0.30',
    date: '2026-11-17',
    en: [
      'Split bone (Inspector, Split section, in Setup mode): cuts the selected bone into 2 to 32 shorter bones along its length. Nested makes a chain (every new bone is a child of the one before: tails, spines, tentacles), without it the parts stand side by side under the parent of the bone. Fibonacci makes each part shorter than the one before (5 3 2 1 1), otherwise the lengths are equal. The original keeps its name, slots, weights and keys and becomes the first part. In a chain the children of the bone move to the part they sit on, so a hand at the end of a forearm follows the last part. One step in the history.',
    ],
    ru: [
      'Разрезать кость (Инспектор, раздел «Разрезать», режим Setup): делит выбранную кость вдоль на 2–32 коротких. «Цепочкой» — каждая новая кость ребёнок предыдущей (хвосты, позвоночники, щупальца), без неё части стоят рядом под родителем кости. «Фибоначчи» — каждая часть короче предыдущей (5 3 2 1 1), иначе длины равны. Исходная кость сохраняет имя, слоты, веса и ключи и становится первой частью. В цепочке дочерние кости переходят на ту часть, на которой сидят, поэтому кисть на конце предплечья идёт за последней частью. Один шаг в истории.',
    ],
  },
  {
    version: '0.29',
    date: '2026-11-17',
    en: [
      'Set Parent (Shift+P, Edit menu, command palette): select bones (or a slot), start it, then click the new parent bone in the viewport or in the tree. The bones stay where they are, a selected slot moves to the clicked bone, the whole change is one step in the history, Esc or a click on nothing cancels. In Spine it is the P key; here P is the Point tool, so the key is Shift+P (and can be moved in Settings).',
    ],
    ru: [
      'Назначить родителя (Shift+P, меню «Правка», палитра команд): выберите кости (или слот), запустите режим и кликните новую родительскую кость во вьюпорте или в дереве. Кости остаются на месте, выбранный слот переходит на кликнутую кость, всё это один шаг в истории, Esc или клик по пустому месту отменяют. В Spine это клавиша P, у нас P занята инструментом «Точка», поэтому Shift+P (клавишу можно поменять в Настройках).',
    ],
  },
  {
    version: '0.28',
    date: '2026-11-17',
    en: [
      'Folders of images: drop a folder onto the Images window or the viewport (or use the new folder button of the Images window) and every picture in it is imported, subfolders included. The folders stay: "hero/arm/upper.png" is the picture "hero/arm/upper", shown in a folder of the Images window. Numbered files come in the natural order (frame2 before frame10). A whole folder is one step in the history. A folder dropped on the viewport only fills the Images window, it does not put a hundred slots on the scene.',
    ],
    ru: [
      'Папки с картинками: перетащите папку в окно «Картинки» или во вьюпорт (или нажмите новую кнопку с папкой в окне «Картинки») — импортируются все картинки в ней, включая вложенные папки. Папки сохраняются: «hero/arm/upper.png» становится картинкой «hero/arm/upper» в папке окна «Картинки». Пронумерованные файлы идут в естественном порядке (frame2 раньше frame10). Вся папка — один шаг в истории. Папка, брошенная во вьюпорт, только наполняет окно «Картинки» и не ставит сотню слотов на сцену.',
    ],
  },
  {
    version: '0.27',
    date: '2026-11-17',
    en: [
      'Update from PSD: the artist repaints the Photoshop file, the rig stays. The new button in the Images window reads a .psd and matches its layers to the pictures by name ("group/layer"): the matched pictures get the new pixels, a region attachment follows the new size and the way the layer moved (and keeps the scale you gave it), meshes keep their shape, a layer the project has not got yet becomes a new slot right above the layer under it in the file, and nothing is removed. One step in the history (the old pixels do not come back with Undo, as with Replace image).',
    ],
    ru: [
      'Обновление из PSD: художник правит файл Photoshop, а риг остаётся. Новая кнопка в окне «Картинки» читает .psd и сопоставляет слои с картинками по имени («группа/слой»): совпавшие картинки получают новые пиксели, регион следует за новым размером и за тем, как сдвинулся слой (и сохраняет масштаб, который вы задали), меши сохраняют форму, слой, которого в проекте ещё нет, становится новым слотом сразу над нижележащим слоем файла, ничего не удаляется. Один шаг в истории (старые пиксели с Undo не возвращаются, как и при «Заменить картинку»).',
    ],
  },
  {
    version: '0.26',
    date: '2026-11-17',
    en: [
      'Photoshop import: drop a .psd file into the window (or the Images window) and every visible layer becomes a picture and a slot with a region, bottom layer first, so the layer stack is the draw order. Groups become folders ("arm/upper"), layer opacity becomes the slot alpha, multiply / screen / linear dodge become Spine blend modes, hidden layers are skipped. The origin is the middle of the bottom edge of the document. One Undo removes the whole import.',
    ],
    ru: [
      'Импорт из Photoshop: перетащите файл .psd в окно (или в окно «Картинки») — каждый видимый слой станет картинкой и слотом с регионом, нижний слой первым, так что стопка слоёв — это порядок отрисовки. Группы становятся папками («arm/upper»), прозрачность слоя — альфой слота, режимы multiply / screen / linear dodge — режимами наложения Spine, скрытые слои пропускаются. Начало координат — середина нижней кромки документа. Один Undo убирает весь импорт.',
    ],
  },
  {
    version: '0.25',
    date: '2026-11-17',
    en: [
      'Every animation now has its own playback settings: Loop, Ping-pong and the play range (Playback window and the loop button of the timeline). They are saved with the project and not exported, so a walk can loop while a jump plays once, and the range you set on one animation no longer leaks into the others.',
    ],
    ru: [
      'У каждой анимации теперь свои настройки воспроизведения: цикл, пинг-понг и диапазон (окно «Воспроизведение» и кнопка цикла в таймлайне). Они сохраняются в проекте и не попадают в экспорт: ходьба может идти по кругу, а прыжок играть один раз, и диапазон одной анимации больше не переходит на другие.',
    ],
  },
  {
    version: '0.24',
    date: '2026-11-17',
    en: [
      'Linked meshes: a skin can dress a mesh in another picture and keep its shape, weights and deform. Pick a picture for a mesh in the "In skin" field of the Inspector (with a skin selected) and the skin gets a linked mesh of the same name that follows the mesh of the default skin. The shape of a linked mesh is always the shape of its source (edit the source, every linked mesh follows; the Unlink button cuts one loose), the deform animation of the source moves it too (Share deform), and the file carries the link: Spine JSON and binary files write and read real linkedmesh attachments, also from another slot or skin. Before, a linked mesh of an imported file became an independent copy.',
      'View: Shift+F frames the selected bones (or the bone of the selected slot), Shift+Z sets the zoom to 100% (one scene unit per screen pixel). Both are in the View menu and the command palette, and can be moved in Settings.',
      'Deform: in Animate mode the vertices that the current pose has moved are drawn in orange in the Mesh tool, so it is clear where a deform already is.',
    ],
    ru: [
      'Linked mesh: скин может одеть сетку в другую картинку и оставить её форму, веса и деформацию. Выберите картинку для сетки в поле «В скине» инспектора (при выбранном скине) — в скине появится linked mesh с тем же именем, который повторяет сетку скина по умолчанию. Форма linked mesh всегда равна форме источника (правите источник — все связанные сетки следуют; кнопка «Отвязать» отрезает одну), анимация деформации источника двигает и её («Общая деформация»), а файл хранит связь: JSON и бинарные файлы Spine пишут и читают настоящие linkedmesh, в том числе из другого слота или скина. Раньше linked mesh из импортированного файла становился независимой копией.',
      'Вид: Shift+F показывает выделенные кости (или кость выбранного слота), Shift+Z ставит масштаб 100% (одна единица сцены на пиксель экрана). Оба есть в меню «Вид» и в палитре команд, клавиши меняются в настройках.',
      'Деформация: в режиме анимации вершины, которые текущая поза сдвинула, рисуются оранжевым в инструменте сетки — видно, где деформация уже есть.',
    ],
  },
  {
    version: '0.23',
    date: '2026-11-17',
    en: [
      'Events: click an event in the Hierarchy to open it and set its default Int, Float and Text, and its Sound (the path of the sound file for the engine) with Volume and Balance. A key of the event in an animation can override the volume and balance. Sounds are kept in the Spine export (JSON and binary) and in the import, so Spine projects with sounds no longer lose them; the editor does not play them. Every event key of a sound is written with both numbers, because the official 4.3.13 JSON loader takes the volume of the definition as the default balance.',
      'Pasting colour keys onto another slot: two-colour keys become plain colour keys when the slot has no dark colour.',
    ],
    ru: [
      'События: щёлкните по событию в иерархии, чтобы открыть его и задать значения по умолчанию (целое, дробное, текст) и звук (путь к файлу звука для движка) с громкостью и балансом. Ключ события в анимации может переопределить громкость и баланс. Звуки сохраняются в экспорте Spine (JSON и бинарном) и в импорте, так что проекты Spine со звуками больше их не теряют; редактор звук не проигрывает. Каждый ключ события со звуком пишется с обоими числами, потому что официальный загрузчик JSON 4.3.13 берёт громкость описания как баланс по умолчанию.',
      'Вставка ключей цвета на другой слот: двухцветные ключи становятся обычными, если у слота нет тёмного цвета.',
    ],
  },
  {
    version: '0.22',
    date: '2026-11-17',
    en: [
      'Rulers, guides and snapping (View menu, and two buttons in the viewport): rulers along the top and left show the scene units. Drag a guide out of a ruler (from the top one a horizontal line, from the left one a vertical line), drag a guide to move it, drag it back onto its ruler to take it away; Clear guides removes them all. Guides are saved with the project and are not part of the export. Snap puts new bones and moved bones on the grid, and on a guide when one is close.',
    ],
    ru: [
      'Линейки, направляющие и привязка (меню «Вид» и две кнопки во вьюпорте): линейки сверху и слева показывают единицы сцены. Вытащите направляющую из линейки (из верхней горизонтальную, из левой вертикальную), потяните её, чтобы сдвинуть, или верните на линейку, чтобы убрать; «Убрать направляющие» стирает все. Направляющие сохраняются в проекте и в экспорт не попадают. Привязка ставит новые и двигаемые кости на сетку, а рядом с направляющей — на неё.',
    ],
  },
  {
    version: '0.21',
    date: '2026-11-17',
    en: [
      'Pasting keys: keys copied from one bone go onto the bone that is selected now, so the swing of one arm can be pasted onto the other (select the other bone and press Ctrl+V; several selected bones each get a copy). The same for the keys of one slot. With the same bone selected the keys stay where they were.',
      'Settings: Bone size (50 to 200 percent) and Hints (switch the pop-up hints off).',
    ],
    ru: [
      'Вставка ключей: ключи, скопированные с одной кости, вставляются на кость, выбранную сейчас, так что взмах одной руки можно вставить на другую (выберите другую кость и нажмите Ctrl+V; каждая из нескольких выбранных костей получит копию). То же для ключей одного слота. Если выбрана та же кость, ключи остаются на месте.',
      'Настройки: «Толщина костей» (от 50 до 200 процентов) и «Подсказки» (можно выключить всплывающие подсказки).',
    ],
  },
  {
    version: '0.20',
    date: '2026-11-17',
    en: [
      'Sequences: a region or a mesh can show a different picture over time (smoke, fire, a blink drawn frame by frame). Number the pictures (flame01, flame02…), select the image and press Make a sequence in the Inspector: the numbered series is found and the frames are set. In Animate mode key the Mode (hold, once, loop, ping-pong and the backwards versions), the Frame and the Delay; the keys have their own Sequences rows in the dopesheet and move, copy and delete like any key. The Spine export (JSON and binary) and the import (JSON and binary) carry sequences, every frame goes into the atlas, and the tests compare the frame shown at every time with the official Spine 4.3 runtime. The Metrics window warns about missing frames.',
    ],
    ru: [
      'Последовательности: регион или меш может показывать разные картинки по времени (дым, огонь, моргание, нарисованное покадрово). Пронумеруйте картинки (flame01, flame02…), выберите изображение и нажмите «Сделать последовательность» в инспекторе: ряд картинок находится сам, кадры настраиваются. В режиме Animate ставьте ключи на «Режим» (держать, один раз, по кругу, туда-обратно и версии назад), «Кадр» и «Задержку»; у ключей своя строка «Последовательности» в таймлайне, их можно двигать, копировать и удалять как обычные. Экспорт Spine (JSON и бинарный) и импорт (JSON и бинарный) переносят последовательности, каждый кадр попадает в атлас, а тесты сверяют кадр на каждом времени с официальным рантаймом Spine 4.3. Окно «Сводка» предупреждает, если кадра не хватает.',
    ],
  },
  {
    version: '0.19',
    date: '2026-11-17',
    en: [
      'Close the loop (Animation tools window and the command palette): makes the end of the animation the same as its start, so a walk or an idle repeats without a jump. Every number timeline gets the value of its first key on its last key (or the other way round), and one that ends early gets a key at the end. Works on the selected bones or on the whole animation.',
    ],
    ru: [
      'Замкнуть петлю (окно «Инструменты анимации» и палитра команд): делает конец анимации таким же, как начало, чтобы ходьба или покой повторялись без скачка. Каждая дорожка получает на последнем ключе значение первого (или наоборот), а дорожка, которая кончается раньше, получает ключ в конце. Работает на выбранных костях или на всей анимации.',
    ],
  },
  {
    version: '0.18',
    date: '2026-11-17',
    en: [
      'Texture packer options in the Export window: Strip whitespace (cuts the empty border off pictures, the atlas file records where it was; pictures a mesh uses stay whole), Rotate pictures (a quarter turn on the page when that saves room) and Texture filter (Linear, or Nearest for pixel art). The atlas is read back by the official Spine runtime in the tests, and every point of every region has to land on the right pixel. Export settings are remembered, and Save settings / Load settings keep them in a small JSON file to share with a team.',
    ],
    ru: [
      'Параметры упаковщика текстур в окне экспорта: «Обрезать пустоту» (убирает пустую кайму у картинок, файл атласа помнит, где она была; картинки мешей остаются целыми), «Поворачивать картинки» (боком на странице, если это экономит место) и «Фильтр текстуры» (Linear или Nearest для пиксельной графики). В тестах атлас читает официальный рантайм Spine, и каждая точка каждого региона должна попасть на свой пиксель. Настройки экспорта запоминаются, а «Сохранить настройки» / «Загрузить настройки» кладут их в небольшой JSON-файл, который можно передать команде.',
    ],
  },
  {
    version: '0.17',
    date: '2026-11-17',
    en: [
      'Hierarchy filter: type part of a name to see only the matching bones, slots (also by the name of their images), constraints, skins and events, with the bones above them. Ctrl+H shows everything that was hidden in the viewport, Ctrl+Shift+H hides everything except the selection (a slot, or the bones with their children and slots). Both are in the Edit menu and the command palette, and their keys can be moved in Settings.',
    ],
    ru: [
      'Фильтр иерархии: введите часть имени, и останутся только подходящие кости, слоты (в том числе по имени их картинок), констрейнты, скины и события вместе с костями над ними. Ctrl+H показывает всё, что скрыто во вьюпорте, Ctrl+Shift+H скрывает всё, кроме выбранного (слота или костей с детьми и слотами). Обе команды есть в меню «Правка» и в палитре, клавиши можно поменять в настройках.',
    ],
  },
  {
    version: '0.16',
    date: '2026-11-17',
    en: [
      'Poses window (Windows menu): a library of poses kept by name (a guard stance, a wave, a hand shape). Press + to keep the pose of the selected bones (all when none is selected); click a pose to put it on the bones. In Setup mode it sets the setup pose, in Animate mode it keys the bones at the playhead. A Blend percentage puts a pose on only part of the way, angles turning the short way round. Rename, replace with the current pose, delete. The library is saved in the project file and is not part of the Spine export.',
    ],
    ru: [
      'Окно «Позы» (меню «Окна»): библиотека поз с именами (стойка, взмах руки, форма кисти). Нажмите +, чтобы сохранить позу выбранных костей (всех, если ничего не выбрано), клик по позе накладывает её на кости. В режиме Setup поза становится позой по умолчанию, в режиме Animate кости получают ключи в точке маркера. Процент «Наложение» кладёт позу лишь частично, углы идут по короткой дуге. Можно переименовать позу, заменить её текущей или удалить. Библиотека сохраняется в файле проекта и в экспорт Spine не попадает.',
    ],
  },
  {
    version: '0.15',
    date: '2026-11-17',
    en: [
      'Every key of the editor can be moved: Settings → Hotkeys now has a button for each command (Undo, Save, Frame skeleton, Play…), not only the tool letters. Press it, then the new combination (Ctrl, Alt, Shift and a key, F-keys, Tab, Space). A combination that another command, a tool letter or the browser already has is refused with the name of the owner; Reset puts the default back. The tooltips, menus, shortcuts window and command palette show the keys as you set them.',
    ],
    ru: [
      'Теперь можно переназначить любую клавишу редактора: в «Настройки → Горячие клавиши» у каждой команды (Отменить, Сохранить, Показать весь скелет, Воспроизведение…) есть кнопка, не только у букв инструментов. Нажмите её и затем новое сочетание (Ctrl, Alt, Shift и клавиша, F-клавиши, Tab, Space). Сочетание, которое уже занято другой командой, буквой инструмента или браузером, не принимается, и сообщение называет, чем оно занято; «Сбросить» возвращает исходное. Подсказки, меню, окно горячих клавиш и палитра команд показывают клавиши так, как вы их задали.',
    ],
  },
  {
    version: '0.14',
    date: '2026-11-17',
    en: [
      'Animation tools window (Windows menu). Simplify keys takes out the keys a curve does not need, within a tolerance you scale; it shows how many can go before you press the button. Bake constraints writes what IK, transform, path, physics and sliders do into plain bone keys of a new animation (every frame or every N-th, optionally simplified, constraints switched off in the copy), so the motion plays the same where a game runtime has no such constraint. Checked frame by frame in the random-session tests.',
      'The one difference from the official runtime that the random-session tests could not explain turned out to be the test reading a bone on the 0/360 wrap before a slider moved it; the test now knows about that, the editor needed no change.',
    ],
    ru: [
      'Окно «Инструменты анимации» (меню «Окна»). «Упрощение ключей» убирает ключи, которые кривой не нужны, в допуске, который можно менять; перед нажатием видно, сколько уйдёт. «Запечь констрейнты» записывает работу IK, transform, path, физики и слайдеров в обычные ключи костей новой анимации (каждый кадр или каждый N-й, с упрощением по желанию, констрейнты в копии выключены), и движение играет так же там, где в игровом рантайме таких констрейнтов нет. Сверено кадр за кадром в тестах со случайными сессиями.',
      'Единственное расхождение с официальным рантаймом, которое случайные сессии не смогли объяснить, оказалось тестом: он читал кость на стыке 0/360 после того, как слайдер её повернул. Теперь тест это знает, редактор менять не пришлось.',
    ],
  },
  {
    version: '0.13',
    date: '2026-11-17',
    en: [
      'Motion trails (View menu, or the route button in the top bar): the path that the selected bones travel in the animation, cool before the playhead and warm after it, with the keys marked on it. Spine has nothing like it.',
    ],
    ru: [
      'Траектории движения (меню «Вид» или кнопка с маршрутом в верхней панели): путь, который выбранные кости проходят в анимации, холодным цветом до маркера и тёплым после него, с отмеченными ключами. В Spine такого нет.',
    ],
  },
  {
    version: '0.12',
    date: '2026-11-17',
    en: [
      'Playback window (Windows menu): speed, loop, ping-pong and a play range that you set from the playhead; the range is shown on the ruler and what is outside it is dimmed.',
      'Save now writes to the file the project came from (Ctrl+S, no dialog); Save as… (Ctrl+Shift+S) asks where. The Welcome window lists recent projects (Chrome, Edge and other browsers with file handles).',
      'Export size: 100% / 75% / 50% / 25% / 200%. The pictures of the atlas and the skeleton (bones, meshes, translations, constraints) are scaled together, the way the official loader scales; checked against it.',
      'Images window: folders (a / in the name), rename (attachments follow), replace the picture under the same name, unused images marked and a button that removes them.',
      'Weights: Prune (drops influences under 5% and keeps at most 4 bones per vertex) and Mirror L→R / R→L (copies the weights of one half to the other, bones swapped for their mirror twins).',
      'Timeline: Ctrl+Alt-drag a key to offset keys round the loop (what leaves the end comes back at the start), and a Zoom to keys button.',
      'A slider without an animation no longer changes the update order of the bones, which could make a path constraint differ from the exported file (found by the random-session tests).',
    ],
    ru: [
      'Окно «Воспроизведение» (меню «Окна»): скорость, цикл, туда-обратно и диапазон воспроизведения, который задаётся от маркера; диапазон виден на линейке, всё вне его затемнено.',
      'Сохранить теперь пишет в тот же файл, из которого открыт проект (Ctrl+S, без диалога); «Сохранить как…» (Ctrl+Shift+S) спрашивает, куда. В окне приветствия виден список недавних проектов (Chrome, Edge и другие браузеры с файловыми хэндлами).',
      'Размер экспорта: 100% / 75% / 50% / 25% / 200%. Картинки атласа и скелет (кости, меши, смещения, констрейнты) масштабируются вместе, как это делает официальный загрузчик; сверено с ним.',
      'Окно «Картинки»: папки (/ в имени), переименование (вложения следуют за именем), замена картинки под тем же именем, неиспользуемые помечены, кнопка убирает их.',
      'Веса: «Очистить» (убирает влияния слабее 5% и оставляет не больше 4 костей на вершину) и «Зеркало Л→П / П→Л» (копирует веса одной половины на другую, кости заменяются зеркальными двойниками).',
      'Таймлайн: Ctrl+Alt-перетаскивание ключа сдвигает ключи по кругу (ушедшее за конец возвращается в начало) и кнопка «Масштаб по ключам».',
      'Слайдер без анимации больше не меняет порядок обновления костей: из-за него path-констрейнт мог отличаться от экспортированного файла (нашли случайные сессии в тестах).',
    ],
  },
  {
    version: '0.11',
    date: '2026-11-17',
    en: [
      'Binary .skel: Export → Skeleton file → Binary (about half the size of the JSON), and File → Import Spine data opens .skel files of Spine 4.3. Both are checked against the official SkeletonBinary loader, including files written the way Spine writes them (split timelines, separate rgb and alpha, linked meshes, sequences, audio events).',
    ],
    ru: [
      'Бинарный .skel: Экспорт → Файл скелета → Бинарный (примерно вдвое меньше JSON), а Файл → Импорт данных Spine открывает .skel от Spine 4.3. Оба направления сверены с официальным загрузчиком SkeletonBinary, в том числе на файлах в том виде, как их пишет Spine (раздельные таймлайны, отдельные rgb и alpha, linked mesh, sequences, события со звуком).',
    ],
  },
  {
    version: '0.10',
    date: '2026-11-17',
    en: [
      "Skins window (Windows menu): the skins with their own attachments, a copy of a skin, and the skin scope: lock a bone or a constraint so it exists only in the skins you tick (a hat, a second tail), like Spine's skin bones and skin constraints.",
      'Fixed against the official runtime: bones, slots and constraints that a skin does not activate are now skipped by animations exactly as in Spine, and a bone below a skin-required bone is required too.',
    ],
    ru: [
      'Окно «Скины» (меню «Окна»): скины с их собственными вложениями, копия скина и скоуп скина: замок на кости или констрейнте делает её существующей только в отмеченных скинах (шляпа, второй хвост), как skin bones и skin constraints в Spine.',
      'Исправлено по официальному рантайму: кости, слоты и констрейнты, которые скин не включает, анимации теперь пропускают в точности как в Spine, а кость под «только для скинов» тоже становится такой.',
    ],
  },
  {
    version: '0.9',
    date: '2026-11-17',
    en: [
      'New demo rig "Kit": a fox with weighted meshes, IK legs, a physics tail, ears and scarf, two skins (red and arctic) and four animations (idle, walk, wave, jump) with blinking, a draw-order change and events. Try it from the Welcome window.',
    ],
    ru: [
      'Новый демо-риг «Kit»: лиса с мешами и весами, IK-ногами, физичным хвостом, ушами и шарфом, двумя скинами (рыжий и арктический) и четырьмя анимациями (idle, walk, wave, jump) с морганием, сменой порядка отрисовки и событиями. Открыть можно из окна приветствия.',
    ],
  },
  {
    version: '0.8',
    date: '2026-11-17',
    en: [
      'Export an animation to a transparent GIF, a PNG sequence (ZIP) or a WebM video: Export, Animation tab. In the data export you can choose which animations go in, power-of-two pages and the preview page.',
      'Command palette (Ctrl+K): any command, tool, window or animation by name. History window: every step, click to go back or forward to it.',
      'Welcome window with the ways to start (demo, new, open, import from Spine), first steps and links.',
    ],
    ru: [
      'Экспорт анимации в GIF с прозрачностью, последовательность PNG (ZIP) или видео WebM: Экспорт, вкладка «Анимация». В экспорте данных можно выбрать, какие анимации попадут в файл, страницы степени двойки и страницу предпросмотра.',
      'Палитра команд (Ctrl+K): любая команда, инструмент, окно или анимация по названию. Окно «История»: все шаги, клик возвращает или двигает вперёд до нужного.',
      'Окно приветствия: способы начать (демо, новый, открыть, импорт из Spine), первые шаги и ссылки.',
    ],
  },
  {
    version: '0.7',
    date: '2026-11-17',
    en: [
      'Windows menu: open and close Hierarchy, Images, Animations, Metrics, Inspector and Timeline, ready layouts, F9 hides everything. The choice is remembered.',
      'New windows: Animations (folders by "/" in the name, duplicate, rename, clean up) and Metrics (bones, meshes, vertices, keys and what looks forgotten before an export).',
      'Settings (F12): language, autosave, viewport background, smoothing, zoom to mouse, onion skin frames, and tool letters you can change.',
      'Shear tool (H); Edit menu with Duplicate and Mirror bones (Ctrl+D, Ctrl+Shift+D), Reset / Copy / Paste pose.',
      'Animation: onion skin (faded poses before and after the playhead), Clean Up removes keys that change nothing, Alt-drag a key to shift the keys after it too.',
    ],
    ru: [
      'Меню «Окна»: открывайте и закрывайте Иерархию, Картинки, Анимации, Сводку, Инспектор и Таймлайн, готовые раскладки, F9 прячет всё. Выбор запоминается.',
      'Новые окна: Анимации (папки по «/» в названии, дубль, переименование, очистка) и Сводка (кости, меши, вершины, ключи и что похоже на забытое перед экспортом).',
      'Настройки (F12): язык, автосохранение, фон вьюпорта, сглаживание, зум в курсор, кадры onion skin и буквы инструментов, которые можно менять.',
      'Инструмент Shear (H); меню «Правка» с дублированием и зеркальной копией костей (Ctrl+D, Ctrl+Shift+D), сброс / копирование / вставка позы.',
      'Анимация: onion skin (бледные позы до и после маркера), Clean Up убирает ключи, которые ничего не меняют, Alt-перетаскивание ключа сдвигает и ключи после него.',
    ],
  },
  {
    version: '0.6',
    date: '2026-11-17',
    en: [
      'New: Updates window with this list and the live activity of the project, and a Feedback window for bug reports, ideas and missing features.',
      'Interface round: design tokens, tooltips with hotkeys, one shared set of controls and inspectors, a grouped shortcuts window, keyboard navigation in menus and dialogs.',
      'Physics constraints (Spine 4.2+): swing, push, stretch and shear of a bone with inertia, strength, damping, mass, wind and gravity; keyable, exported and imported.',
    ],
    ru: [
      'Новое: окно «Обновления» с этим списком и живой лентой активности проекта, и окно «Обратная связь» для ошибок, идей и недостающих функций.',
      'Раунд интерфейса: токены дизайна, подсказки с горячими клавишами, единый набор контролов и инспекторов, окно горячих клавиш по группам, клавиатура в меню и диалогах.',
      'Констрейнты физики (Spine 4.2+): качание, толчок, растяжение и сдвиг кости с инерцией, силой, затуханием, массой, ветром и гравитацией; ключи, экспорт и импорт.',
    ],
  },
  {
    version: '0.5',
    date: '2026-11-17',
    en: [
      'Import of Spine 4.0, 4.1 and 4.2 JSON: converted to the 4.3 structure on the way in.',
      'Random-session tests now judge ill-conditioned poses by how far the official runtime moves on its own.',
    ],
    ru: [
      'Импорт Spine JSON 4.0, 4.1 и 4.2: по пути конвертируется в структуру 4.3.',
      'Случайные сессии в тестах судят плохо обусловленные позы по тому, насколько сам официальный рантайм «плавает».',
    ],
  },
  {
    version: '0.4',
    date: '2026-11-16',
    en: [
      'Path attachments and path constraints (Spine 4.3): tool N, bezier nodes and handles, every rotate / position / spacing mode, weights and deform.',
      'Transform-constraint mixes can be keyed in the timeline.',
    ],
    ru: [
      'Path-вложения и path-констрейнты (Spine 4.3): инструмент N, узлы и ручки безье, все режимы вращения / позиции / интервала, веса и деформация.',
      'Миксы transform-констрейнтов можно ключевать на таймлайне.',
    ],
  },
  {
    version: '0.3',
    date: '2026-11-16',
    en: ['Two-color tint (light and dark color): shader, inspector, dopesheet and graph, export and import.'],
    ru: ['Двухцветный тинт (светлый и тёмный цвет): шейдер, инспектор, дорожка и график, экспорт и импорт.'],
  },
  {
    version: '0.2',
    date: '2026-11-16',
    en: ['Russian interface: switch EN / RU in the top bar, the choice is remembered.'],
    ru: ['Русский интерфейс: переключатель EN / RU в верхней панели, выбор запоминается.'],
  },
  {
    version: '0.1',
    date: '2026-11-16',
    en: [
      'First public version: bones, meshes, weights, IK, transform constraints, sliders, clipping, bounding boxes, points, skins, events, dopesheet and graph, Spine 4.3 export checked against the official runtime.',
    ],
    ru: [
      'Первая публичная версия: кости, меши, веса, IK, transform-констрейнты, слайдеры, клиппинг, боксы, точки, скины, события, дорожка и график, экспорт Spine 4.3 с проверкой по официальному рантайму.',
    ],
  },
];

export const LATEST = CHANGELOG[0].version;

export const REPO = 'iamgatz/Bone-2D';
export const SITE = 'https://iamgatz.github.io/Bone-2D/';
