/* Доклад Cosmostars — поведение.
 *
 * Три вещи, и ничего сверх: слайд вписывается в экран, элементы въезжают по
 * порядку при каждом заходе, числа досчитываются. Анимация здесь служебная —
 * она показывает, в каком порядке читать кадр, и заканчивается раньше, чем
 * докладчик доходит до второй фразы.
 */
(function () {
  'use strict';

  var deck = document.getElementById('deck');
  var slides = [].slice.call(document.querySelectorAll('.slide'));
  var rail = document.querySelector('#rail i');
  var count = document.getElementById('count');
  var notes = document.getElementById('notes');
  var at = 0;
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- вписывание -------------------------------------------------------
  // Колода свёрстана в 1920×1080 и масштабируется целиком: кегль на проекторе
  // тогда ровно тот, что в вёрстке, а не «примерно такой же».
  function fit() {
    var k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    deck.style.transform = 'translate(' + (-1920 * k / 2) + 'px,' + (-1080 * k / 2) + 'px) scale(' + k + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // --- звёзды -----------------------------------------------------------
  // Слой один на всю колоду и живёт под слайдами: если рисовать его на каждом
  // слайде, на переходе видно шов.
  var sky = document.getElementById('sky');
  if (sky && !calm) {
    var ctx = sky.getContext('2d');
    sky.width = 1920; sky.height = 1080;
    var stars = [];
    for (var i = 0; i < 260; i++) {
      stars.push({
        x: Math.random() * 1920,
        y: Math.random() * 1080,
        r: Math.random() * 1.5 + .3,
        a: Math.random() * .5 + .15,
        // Дальние звёзды ползут медленнее ближних — этого хватает, чтобы фон
        // читался как глубина, а не как шум.
        v: Math.random() * .06 + .012,
        p: Math.random() * Math.PI * 2
      });
    }
    (function draw(t) {
      ctx.clearRect(0, 0, 1920, 1080);
      for (var j = 0; j < stars.length; j++) {
        var s = stars[j];
        s.x -= s.v;
        if (s.x < -4) { s.x = 1924; s.y = Math.random() * 1080; }
        var tw = s.a + Math.sin(t / 1400 + s.p) * .16;
        ctx.globalAlpha = Math.max(.04, tw);
        ctx.fillStyle = j % 11 === 0 ? '#8B7BFF' : '#CBD6E4';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(draw);
    })(0);
  }

  // --- счётчики ---------------------------------------------------------
  // Число доезжает до своего значения, а не появляется готовым: взгляд успевает
  // встать на него до того, как докладчик его назовёт. Формат — тот же, что в
  // пульте: неразрывный пробел по три разряда.
  function group(n, frac) {
    var s = frac ? n.toFixed(frac) : String(Math.round(n));
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts.join(',');
  }

  function runCounters(slide) {
    var nodes = slide.querySelectorAll('[data-count]');
    [].forEach.call(nodes, function (node) {
      var to = parseFloat(node.getAttribute('data-count'));
      var frac = parseInt(node.getAttribute('data-frac') || '0', 10);
      var pre = node.getAttribute('data-pre') || '';
      var post = node.getAttribute('data-post') || '';
      var wait = parseFloat(node.getAttribute('data-delay') || '0') * 1000;
      if (calm) { node.textContent = pre + group(to, frac) + post; return; }
      node.textContent = pre + group(0, frac) + post;
      var t0 = null;
      var dur = 900;
      setTimeout(function () {
        requestAnimationFrame(function step(t) {
          if (t0 === null) t0 = t;
          var k = Math.min(1, (t - t0) / dur);
          var e = 1 - Math.pow(1 - k, 3);
          node.textContent = pre + group(to * e, frac) + post;
          if (k < 1) requestAnimationFrame(step);
        });
      }, wait);
    });
  }

  // --- полосы -----------------------------------------------------------
  function runBars(slide) {
    var bars = slide.querySelectorAll('.bar i');
    [].forEach.call(bars, function (bar) {
      var w = bar.getAttribute('data-w') || '0%';
      bar.style.width = '0';
      var wait = parseFloat(bar.getAttribute('data-delay') || '0') * 1000;
      if (calm) { bar.style.width = w; return; }
      setTimeout(function () { bar.style.width = w; }, wait + 60);
    });
  }

  // --- полоса суток -----------------------------------------------------
  // 288 столбиков — по одному на пятиминутный шаг, высота равна числу окон
  // контакта на этом шаге. Числа настоящие: их снял shoot.py тем же запросом,
  // которым их берёт пульт. Всё, что выше двух, закрашено тревожным цветом —
  // это окна, которыми смена в этот шаг воспользоваться уже не может.
  (function strip() {
    var host = document.getElementById('daystrip');
    var data = window.DECK_DATA;
    if (!host || !data) return;
    // Высота в пикселях, а не в процентах: процент от высоты флекс-контейнера
    // столбик не получает — у элемента нет собственного блока для отсчёта, и
    // полоса схлопывается в ноль. Полотно всё равно масштабируется целиком.
    var tall = 76;
    var top = Math.max.apply(null, data.supply);
    data.supply.forEach(function (n, i) {
      var b = document.createElement('i');
      b.style.cssText = 'flex:1 1 0;align-self:flex-end;border-radius:2px 2px 0 0;' +
        'transform-origin:bottom;' +
        'height:' + Math.max(3, Math.round(n / top * tall)) + 'px;' +
        'background:' + (n > data.limit ? 'var(--warn)' : n ? 'var(--s1)' : 'var(--line)') + ';' +
        'opacity:' + (n ? .92 : .5) + ';';
      // Рост столбика — обычная ключевая анимация с задержкой по номеру шага:
      // она перезапускается сама, когда слайд снова становится живым, тем же
      // способом, что и остальной вход.
      b.style.setProperty('--d', (0.85 + i * 0.0035).toFixed(3) + 's');
      host.appendChild(b);
    });
    host.title = data.windows + ' окон контакта на ' + data.steps + ' шагов';
  })();

  // --- порядок входа ----------------------------------------------------
  // Задержка считается из порядка элементов, а не проставляется руками:
  // при правке слайда ничего не разъезжается.
  function stage(slide) {
    var step = 0.07;
    [].forEach.call(slide.querySelectorAll('[data-a]'), function (node, i) {
      var own = node.getAttribute('data-d');
      node.style.setProperty('--d', (own !== null ? parseFloat(own) : 0.16 + i * step) + 's');
    });
  }

  // --- показ ------------------------------------------------------------
  function show(next, dir) {
    if (next < 0 || next >= slides.length) return;
    var prev = slides[at];
    prev.classList.remove('live', 'in-next', 'in-prev');
    at = next;
    var slide = slides[at];
    stage(slide);
    slide.classList.add('live');
    if (!calm) slide.classList.add(dir < 0 ? 'in-prev' : 'in-next');
    runCounters(slide);
    runBars(slide);

    var main = slides.filter(function (s) { return !s.dataset.appendix; });
    var isApp = !!slide.dataset.appendix;
    rail.style.width = ((at + 1) / slides.length * 100) + '%';
    count.innerHTML = isApp
      ? '<span class="ap">запас · по вопросам</span>'
      : '<b>' + (main.indexOf(slide) + 1) + '</b> / ' + main.length;
    notes.innerHTML = '<b>' + (slide.dataset.label || '') + '</b>' +
      (slide.dataset.notes || 'Заметок нет.');
    location.hash = String(at + 1);
  }

  // --- управление -------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Enter') { show(at + 1, 1); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace') { show(at - 1, -1); e.preventDefault(); }
    else if (k === 'Home') { show(0, -1); }
    else if (k === 'End') { show(slides.length - 1, 1); }
    else if (k === 'n' || k === 'N' || k === 'т' || k === 'Т') { document.body.classList.toggle('notes'); }
    else if (k === 't' || k === 'T' || k === 'е' || k === 'Е') { document.body.classList.toggle('timings'); }
    else if (k === 'f' || k === 'F' || k === 'а' || k === 'А') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    }
  });

  // Клик по половине экрана листает в её сторону: на чужом ноутбуке это
  // единственное управление, которое точно окажется под рукой.
  document.getElementById('stage').addEventListener('click', function (e) {
    if (e.target.closest('a')) return;
    show(e.clientX < window.innerWidth / 2 ? at - 1 : at + 1, e.clientX < window.innerWidth / 2 ? -1 : 1);
  });

  var touch = null;
  document.addEventListener('touchstart', function (e) { touch = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (touch === null) return;
    var dx = e.changedTouches[0].clientX - touch;
    if (Math.abs(dx) > 46) show(dx < 0 ? at + 1 : at - 1, dx < 0 ? 1 : -1);
    touch = null;
  }, { passive: true });

  // Режим печати: колода разворачивается в столбик, показ выключается. Числа
  // при этом должны стоять на своих местах сразу — счётчик до них не доедет.
  if (location.search.indexOf('print') >= 0) {
    document.body.classList.add('print');
    slides.forEach(function (slide) {
      slide.classList.add('live');
      [].forEach.call(slide.querySelectorAll('[data-count]'), function (node) {
        node.textContent = (node.getAttribute('data-pre') || '')
          + group(parseFloat(node.getAttribute('data-count')),
                  parseInt(node.getAttribute('data-frac') || '0', 10))
          + (node.getAttribute('data-post') || '');
      });
      [].forEach.call(slide.querySelectorAll('.bar i'), function (bar) {
        bar.style.width = bar.getAttribute('data-w') || '0%';
      });
    });
    return;
  }

  var start = parseInt((location.hash || '').slice(1), 10);
  show(start > 0 && start <= slides.length ? start - 1 : 0, 1);
})();
