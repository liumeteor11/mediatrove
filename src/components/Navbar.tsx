import React, { useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, Library, User, Menu, X, LogIn, Palette, ChevronDown, Globe, Calendar, Drama } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { useThemeStore, Theme } from '../store/useThemeStore';
import { useTranslation } from 'react-i18next';
import { getAIDate } from '../services/aiService';
import { UpdateButton } from './UpdateButton';
import clsx from 'clsx';

export const Navbar: React.FC = () => {
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = React.useState(false);
  const [isThemeOpen, setIsThemeOpen] = React.useState(false);
  const [isLangOpen, setIsLangOpen] = React.useState(false);
  const themeDropdownRef = useRef<HTMLDivElement>(null);
  const langDropdownRef = useRef<HTMLDivElement>(null);
  const { user, logout } = useAuthStore();
  const { theme, setTheme } = useThemeStore();
  const [aiDate, setAiDate] = React.useState<string>('');

  useEffect(() => {
    getAIDate().then(setAiDate);
  }, [i18n.language]);

  const navLinks = [
    { path: '/', label: t('nav.search'), icon: Search },
    { path: '/collection', label: t('nav.collection'), icon: Library },
    { path: '/characters', label: t('nav.characters'), icon: Drama },
    { path: '/dashboard', label: t('nav.dashboard'), icon: User },
  ];

  const themes: { id: Theme; name: string }[] = [
    { id: 'doraemon', name: 'Doraemon' },
    { id: 'cyberpunk', name: 'Cyberpunk' },
    { id: 'scandinavian', name: 'Minimal' },
    { id: 'gradient', name: 'Gradient' },
  ];

  const languages = [
    { code: 'en', name: 'English' },
    { code: 'zh', name: '中文' },
  ];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (themeDropdownRef.current && !themeDropdownRef.current.contains(event.target as Node)) {
        setIsThemeOpen(false);
      }
      if (langDropdownRef.current && !langDropdownRef.current.contains(event.target as Node)) {
        setIsLangOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
    setIsLangOpen(false);
  };

  return (
    <nav className="backdrop-blur-md border-b sticky top-0 z-50 transition-colors duration-300 bg-theme-surface/90 border-theme-border text-theme-text">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link 
            to="/" 
            className="flex-shrink-0 flex items-center gap-2"
            onClick={(e) => {
                if (location.pathname === '/') {
                    e.preventDefault();
                    window.dispatchEvent(new CustomEvent('reset-search'));
                }
            }}
          >
            <div className="w-8 h-8 rounded-theme flex items-center justify-center transition-colors bg-theme-accent text-theme-bg">
              <Library className="w-5 h-5" />
            </div>
            <span className="font-bold text-xl tracking-tight text-theme-text font-theme">MediaTrove AI</span>
          </Link>
          {aiDate && (
            <div className="hidden lg:flex items-center gap-2 px-3 py-2 rounded-theme text-xs font-medium text-theme-subtext bg-theme-surface/50 max-w-[300px] truncate" title={aiDate}>
              <Calendar className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{aiDate}</span>
            </div>
          )}
          
          <div className="hidden md:block">
            <div className="ml-10 flex items-center space-x-4">
              {navLinks.map(({ path, label, icon: Icon }) => (
                <Link
                  key={path}
                  to={path}
                  className={clsx(
                    "flex items-center gap-2 px-3 py-2 rounded-theme text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors focus:outline-none focus:ring-2 focus:ring-theme-accent",
                    location.pathname === path
                      ? "bg-theme-accent text-theme-bg border-2 border-theme-accent"
                      : "text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </Link>
              ))}



              {/* Update Checker */}
              <UpdateButton />

              {/* Language Dropdown */}
              <div className="relative" ref={langDropdownRef}>
                <button
                  onClick={() => setIsLangOpen(!isLangOpen)}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50 focus:outline-none focus:ring-2 focus:ring-theme-accent"
                >
                  <Globe className="w-4 h-4 flex-shrink-0" />
                  <span className="capitalize">{languages.find(l => l.code === i18n.language.split('-')[0])?.name || t('common.language')}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                
                {isLangOpen && (
                  <div className="absolute right-0 mt-2 w-32 rounded-md shadow-lg py-1 bg-theme-surface border border-theme-border ring-1 ring-black ring-opacity-5 focus:outline-none">
                    {languages.map((l) => (
                      <button
                        key={l.code}
                        onClick={() => changeLanguage(l.code)}
                        className={clsx(
                          "w-full text-left px-4 py-2 text-sm transition-colors",
                          i18n.language.startsWith(l.code)
                            ? "bg-theme-accent text-theme-bg border-2 border-theme-accent"
                            : "text-theme-text hover:bg-theme-bg"
                        )}
                      >
                        {l.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              
              {/* Theme Dropdown */}
              <div className="relative" ref={themeDropdownRef}>
                <button
                  onClick={() => setIsThemeOpen(!isThemeOpen)}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50 focus:outline-none focus:ring-2 focus:ring-theme-accent"
                >
                  <Palette className="w-4 h-4 flex-shrink-0" />
                  <span className="capitalize">{themes.find(t => t.id === theme)?.name || t('common.theme')}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                
                {isThemeOpen && (
                  <div className="absolute right-0 mt-2 w-48 rounded-md shadow-lg py-1 bg-theme-surface border border-theme-border ring-1 ring-black ring-opacity-5 focus:outline-none">
                    {themes.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => {
                          setTheme(t.id);
                          setIsThemeOpen(false);
                        }}
                        className={clsx(
                          "w-full text-left px-4 py-2 text-sm transition-colors",
                          theme === t.id
                            ? "bg-theme-accent text-theme-bg border-2 border-theme-accent"
                            : "text-theme-text hover:bg-theme-bg"
                        )}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {user ? (
                 <button
                  onClick={logout}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap flex-shrink-0 text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  {t('nav.sign_out')}
                </button>
              ) : (
                <Link
                  to="/login"
                  className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap flex-shrink-0 transition-all shadow-sm bg-theme-accent text-theme-bg hover:bg-theme-accent-hover border-2 border-theme-accent focus:outline-none focus:ring-2 focus:ring-theme-accent"
                >
                  <LogIn className="w-4 h-4 flex-shrink-0" />
                  {t('nav.sign_in')}
                </Link>
              )}
            </div>
          </div>

          <div className="-mr-2 flex md:hidden items-center gap-2">
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="inline-flex items-center justify-center p-2 rounded-md focus:outline-none focus:ring-2 focus:ring-inset text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50 focus:ring-theme-accent"
            >
              {isOpen ? <X className="block h-6 w-6" /> : <Menu className="block h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {isOpen && (
        <div className="md:hidden">
          <div className="px-2 pt-2 pb-3 space-y-1 sm:px-3 border-t border-theme-border bg-theme-surface">
             {navLinks.map(({ path, label, icon: Icon }) => (
                <Link
                  key={path}
                  to={path}
                  onClick={() => setIsOpen(false)}
                  className={clsx(
                    "flex items-center gap-2 px-3 py-2 rounded-md text-base font-medium whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-theme-accent",
                    location.pathname === path
                      ? "bg-theme-accent text-theme-bg border-2 border-theme-accent"
                      : "text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50"
                  )}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {label}
                </Link>
              ))}
              
              <div className="px-3 py-2">
                <p className="text-xs font-semibold text-theme-subtext uppercase tracking-wider mb-2">{t('common.select_theme')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {themes.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        setTheme(t.id);
                        setIsOpen(false);
                      }}
                      className={clsx(
                        "flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium border transition-colors",
                        theme === t.id
                          ? "bg-theme-accent text-theme-bg border-2 border-theme-accent"
                          : "bg-theme-bg text-theme-text border-theme-border hover:border-theme-accent"
                      )}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>

               {user ? (
                 <button
                  onClick={() => { logout(); setIsOpen(false); }}
                  className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-base font-medium text-red-500 hover:bg-red-500/10"
                >
                  {t('nav.sign_out')}
                </button>
              ) : (
                <Link
                  to="/login"
                  onClick={() => setIsOpen(false)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-base font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover border-2 border-theme-accent focus:outline-none focus:ring-2 focus:ring-theme-accent"
                >
                  <LogIn className="w-4 h-4" />
                  {t('nav.sign_in')}
                </Link>
              )}
          </div>
        </div>
      )}
    </nav>
  );
};
