(function(){
  var side=document.getElementById('side'),scrim=document.getElementById('scrim'),btn=document.getElementById('menuBtn'),closeBtn=document.getElementById('closeBtn');
  var big=matchMedia('(min-width:1024px)');
  function open(){side.classList.add('open');scrim.classList.add('open');btn.setAttribute('aria-expanded','true');document.body.style.overflow='hidden';closeBtn.focus()}
  function close(ret){side.classList.remove('open');scrim.classList.remove('open');btn.setAttribute('aria-expanded','false');document.body.style.overflow='';if(ret)btn.focus()}
  btn.onclick=open;closeBtn.onclick=function(){close(true)};scrim.onclick=function(){close(true)};
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&side.classList.contains('open'))close(true)});
  if(big.addEventListener)big.addEventListener('change',function(){if(big.matches)close(false)});
  function theme(m){
    var r=document.documentElement;if(m==='auto')r.removeAttribute('data-theme');else r.setAttribute('data-theme',m);
    document.querySelectorAll('[data-t]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.t===m))});
    try{localStorage.setItem('jd-theme',m)}catch(e){}
  }
  document.querySelectorAll('[data-t]').forEach(function(b){b.onclick=function(){theme(b.dataset.t)}});
  var m0='auto';try{m0=localStorage.getItem('jd-theme')||'auto'}catch(e){}
  var q=new URLSearchParams(location.search).get('theme');if(q==='light'||q==='dark')m0=q;
  theme(m0);
})();
