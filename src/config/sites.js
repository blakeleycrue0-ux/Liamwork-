/**
 * The websites this installation watches.
 *
 * They live in code on purpose: nobody adds or removes sites from the
 * dashboard, so the list is reviewed here and applied on every boot. Adding an
 * entry publishes it; the rest of the configuration (selectors, interval) is
 * still editable from the panel.
 */
export const WATCHED_SITES = [
  { name: 'Albatross', url: 'https://www.albatrossgolfklubb.se/' },
  { name: 'Åkersberga', url: 'https://akersbergagk.se/' },
  { name: 'Bro Hof', url: 'https://www.brohofslott.com/' },
  { name: 'Bråviken', url: 'https://bragk.se/' },
  { name: 'Båstad', url: 'https://bgk.se/' },
  { name: 'Barsebäck', url: 'https://www.barseback.com/' },
  { name: 'Borås', url: 'https://www.borasgolfklubb.se/' },
  { name: 'Djursholm', url: 'https://dgk.nu/' },
  { name: 'Hagge', url: 'https://haggegk.se/' },
  { name: 'Haninge', url: 'https://www.haningegk.se/' },
  { name: 'Karlskoga', url: 'https://karlskogagk.se/' },
  { name: 'Kristianstad', url: 'https://kristianstadsgk.com/' },
  { name: 'Kårsta', url: 'https://www.karstagk.se/' },
  { name: 'NSGK', url: 'https://www.nsgk.se/' },
  { name: 'Luleå', url: 'https://www.luleagolf.se/' },
  { name: 'Lund', url: 'https://lagk.se/' },
  { name: 'Skaftö', url: 'https://skaftogk.se/' },
  { name: 'Sundsvall', url: 'https://sundsvallsgk.se/' },
  { name: 'Särö', url: 'https://www.sarogolfclub.se/' },
  { name: 'Upsala', url: 'https://upsalagk.se/' },
  { name: 'Ullna Indoor', url: 'https://ullnaindoor.se/' },
  { name: 'Ullna', url: 'https://ullnagolf.se/' },
  { name: 'Vallda', url: 'https://valldagolf.se/' },
  { name: 'Vasatorp', url: 'https://vasatorp.golf/en/' },
  { name: 'Veckefjärdens', url: 'https://veckefjarden.com/' },
  { name: 'Wermdö', url: 'https://www.wermdogolf.se/' },
  { name: 'Öresund', url: 'https://oresundsgk.se/' },
];

/** Sites that were only ever a test and should not keep being checked. */
export const RETIRED_SITES = ['https://ffsp.info'];
