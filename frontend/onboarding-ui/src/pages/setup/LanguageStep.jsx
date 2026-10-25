// Setup step 3, laid out like a shop page: the chosen host on the left (portrait, qualities, first
// line), the choices on the right (language on one row, then a tile per host who speaks it).
// Changing the language picks that language's default host. Props as in steps.jsx.
import { HOSTS, hostForLanguage, hostsForLanguage } from '../../copy'
import { SETUP } from '../../copy/setup'
import { HostAvatar } from '../../art/hosts'
import { PillChoices, cx } from '../../ui/controls'
import { QualityChips } from '../../ui/QualityChips'
import { StepCard } from './steps'

export function LanguageStep({ data, set, words, onNext, ...frame }) {
  const chooseLanguage = (language) => set({ language, host: hostForLanguage(language) })
  const chooseHost = (id) => set({ host: id })
  return (
    <StepCard {...frame} step={3} aside={<HostShowcase id={data.host} words={words} />} title={words.langTitle} onSubmit={onNext}>
      <PillChoices
        name="language"
        legend={SETUP.language.legend}
        options={[
          { value: 'en', label: SETUP.language.en },
          { value: 'es', label: SETUP.language.es },
        ]}
        value={data.language}
        onChange={chooseLanguage}
      />
      <fieldset className="w-full min-w-0">
        <legend className="mb-3 font-bold">{SETUP.language.hostLegend}</legend>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
          {hostsForLanguage(data.language).map((id) => (
            <HostTile key={id} id={id} checked={data.host === id} onChange={chooseHost} />
          ))}
        </div>
      </fieldset>
    </StepCard>
  )
}

/** The "product": the chosen host, big, with their qualities and how they open a call. */
function HostShowcase({ id, words }) {
  const host = HOSTS[id]
  return (
    <div aria-live="polite" className="flex w-full min-w-0 flex-col items-start gap-4 rounded-inset bg-wash p-6">
      <HostAvatar key={id} id={id} className="h-40 w-40 self-center motion-safe:animate-enter md:h-64 md:w-64" />
      <span className="tag">{words.hostTag}</span>
      <h2 className="text-[2rem]">{host.name}</h2>
      <QualityChips qualities={host.qualities} />
      <p className="text-sm text-muted">{host.blurb}</p>
      <p className="border-l-4 border-line pl-5 font-display italic leading-snug">{words.hostLine}</p>
      {words.hostTranslation && <p className="text-sm text-muted">{words.hostTranslation}</p>}
    </div>
  )
}

/** A host to pick: small portrait + name, a real radio inside (the whole tile is the label). */
function HostTile({ id, checked, onChange }) {
  return (
    <label
      className={cx(
        'relative flex cursor-pointer flex-col items-center gap-2 rounded-inset border-2 px-3 py-4 transition-colors hover:border-rose has-[:focus-visible]:outline has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ink',
        checked ? 'border-rose bg-rose-wash shadow-[0_0_0_2px_theme(colors.rose.DEFAULT)]' : 'border-field bg-white',
      )}
    >
      <input type="radio" name="host" value={id} checked={checked} onChange={() => onChange(id)} className="sr-only" />
      <HostAvatar id={id} className="h-16 w-16" />
      <span className="font-bold leading-snug">{HOSTS[id].name}</span>
      {checked && (
        <span aria-hidden="true" className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-rose motion-safe:animate-pop">
          <span className="mb-0.5 block h-3.5 w-[0.4rem] rotate-45 border-b-[3px] border-r-[3px] border-white" />
        </span>
      )}
    </label>
  )
}
