import { useId, type ReactNode } from 'react';

/**
 * The Adovia One lockup: the rocket, the ADOVIA wordmark, and the product name
 * tracked out beneath it.
 *
 * Built from `adovia-black-logo.svg` in the Adovia site repo, which is the
 * Adovia Launchpad lockup — the same rocket and wordmark with LAUNCHPAD in the
 * lower slot. The mark and the wordmark are that file's own outlines, unchanged.
 * Only the sub-word is different, because that slot holds the product name and
 * this product is not Launchpad.
 *
 * ONE is set to the measured metrics of the LAUNCHPAD it replaces rather than
 * to anything chosen by eye. Laying live Space Grotesk over the original
 * outlines matched them glyph for glyph, which identified the face; from there
 * the original's cap height (7.21 units) and ink width (75.13 across nine
 * letters) give the size and the tracking below. The reproduction lands within
 * 0.4% of the artwork, so the two lockups are the same typographic object.
 *
 * The sub-word is NOT justified out to the width of the wordmark, which is what
 * LAUNCHPAD does. That works for nine letters and falls apart for three: ONE
 * stretched across the full 76 units reads as three initials with no word
 * between them. Matching the tracking rather than the width keeps the type
 * treatment and drops the coincidence of length.
 *
 * INLINE, not an `<img src="/adovia-logo.svg">`, and the reason is the theme.
 * An externally referenced SVG is a separate document: it cannot see this
 * page's `color`, so `currentColor` inside it resolves against its own root
 * regardless of what the app is doing. The alternative is shipping the black
 * and the white artwork as two files and swapping them on `[data-theme]` — two
 * requests, two files to keep in step, and a visible flash on the theme toggle
 * because the second is not fetched until the moment it is first shown.
 * Inlined, the wordmark is simply text-coloured and follows `--ink` for free.
 *
 * The rocket keeps its literal orange gradient rather than taking
 * `currentColor` too. That gradient is byte-identical in the black and the
 * white source files, which is the artwork stating it is not supposed to vary.
 * It sits near this app's `--accent`, but those are two separate facts, and
 * tying one to the other would mean a future accent change silently repainted
 * the logo.
 */
export function Logo({ className }: { className?: string }) {
  /*
    A generated id, because `url(#...)` resolves against the whole document.
    Two logos on one page sharing a hardcoded gradient id would be duplicate
    ids — invalid, and the kind of fault that renders correctly right up until
    something clones or reorders the DOM. `useId` costs nothing and settles it.
  */
  const grad = useId();

  return (
    <svg
      className={className}
      viewBox="0 0 112 29"
      fill="none"
      /*
        `role="img"` with a label, rather than letting a reader walk the
        artwork. It also covers the `<text>` below: a labelled `role="img"`
        makes its children presentational, so ONE is not announced a second
        time after the name has already been read.
      */
      role="img"
      aria-label="Adovia One"
    >
      <path
        d="M2.76794 12.4222L6.15104 13.825C5.76959 14.788 5.46532 15.7798 5.2411 16.791L5.11278 17.3743L9.96285 22.2273L10.5461 22.1019C11.5574 21.8777 12.5492 21.5734 13.5122 21.192L14.915 24.5751C14.9287 24.6086 14.9506 24.6382 14.9786 24.6612C15.0066 24.6841 15.0399 24.6998 15.0755 24.7068C15.1111 24.7137 15.1478 24.7117 15.1824 24.7009C15.217 24.6901 15.2484 24.6709 15.2737 24.645L17.394 22.5248C17.74 22.1788 18.0096 21.7641 18.1854 21.3075C18.3613 20.8508 18.4394 20.3624 18.4147 19.8737L18.3389 18.5117C22.2645 15.6128 26.2367 10.5294 27.3187 1.65752C27.3494 1.43509 27.3283 1.20857 27.257 0.995622C27.1858 0.782676 27.0664 0.589058 26.908 0.429859C26.7497 0.27066 26.5567 0.15018 26.3441 0.0778112C26.1316 0.00544234 25.9052 -0.0168607 25.6826 0.0126406C16.8136 1.1034 11.7273 5.07853 8.82835 8.99242L7.46928 8.92242C6.98164 8.89589 6.49385 8.9717 6.03728 9.14499C5.5807 9.31828 5.16545 9.5852 4.81821 9.9286L2.69795 12.0489C2.66857 12.0738 2.64632 12.1061 2.63344 12.1425C2.62057 12.1788 2.61753 12.2179 2.62464 12.2558C2.63174 12.2937 2.64874 12.3291 2.67391 12.3583C2.69907 12.3875 2.73152 12.4095 2.76794 12.4222ZM16.3703 7.25421C16.7378 6.88803 17.2055 6.63895 17.7144 6.53841C18.2233 6.43787 18.7506 6.49038 19.2297 6.68931C19.7088 6.88824 20.1182 7.22468 20.4062 7.65613C20.6942 8.08758 20.8479 8.5947 20.8479 9.11345C20.8479 9.6322 20.6942 10.1393 20.4062 10.5708C20.1182 11.0022 19.7088 11.3387 19.2297 11.5376C18.7506 11.7365 18.2233 11.789 17.7144 11.6885C17.2055 11.588 16.7378 11.3389 16.3703 10.9727C16.1256 10.7288 15.9314 10.4391 15.799 10.12C15.6665 9.80097 15.5983 9.45891 15.5983 9.11345C15.5983 8.76799 15.6665 8.42592 15.799 8.10687C15.9314 7.78782 16.1256 7.49806 16.3703 7.25421ZM2.13507 22.6152C1.57366 22.4182 0.97079 22.3699 0.385198 22.4752C0.333152 22.4865 0.279103 22.4843 0.2281 22.469C0.177097 22.4537 0.130806 22.4258 0.0935517 22.3877C0.0473685 22.3417 0.0164433 22.2826 0.00496636 22.2185C-0.00651058 22.1543 0.0020156 22.0881 0.0293896 22.029C0.650595 20.6932 2.29839 18.0072 5.28193 20.177C5.29752 20.191 5.30998 20.2081 5.31852 20.2272C5.32706 20.2463 5.33147 20.2669 5.33147 20.2879C5.33147 20.3088 5.32706 20.3295 5.31852 20.3486C5.30998 20.3677 5.29752 20.3847 5.28193 20.3987C4.8825 20.7132 4.56269 21.1174 4.34838 21.5784C4.13407 22.0395 4.03126 22.5445 4.04827 23.0527C4.05044 23.1123 4.0751 23.1689 4.1173 23.2111C4.1595 23.2533 4.21611 23.278 4.27575 23.2801C4.78174 23.3005 5.28544 23.2018 5.74637 22.9921C6.20731 22.7824 6.61262 22.4675 6.92973 22.0727C6.94368 22.0557 6.96125 22.0419 6.98118 22.0324C7.0011 22.023 7.02288 22.0181 7.04493 22.0181C7.06698 22.0181 7.08876 22.023 7.10868 22.0324C7.12861 22.0419 7.14618 22.0557 7.16013 22.0727C7.57427 22.5656 8.7146 24.1755 7.45178 25.73C6.90047 26.3926 6.11055 26.8116 5.25277 26.8966C4.02785 27.0278 1.76468 27.4273 0.840165 28.4831C0.803052 28.5271 0.754701 28.5602 0.700266 28.5788C0.645832 28.5975 0.587357 28.601 0.531076 28.589C0.474796 28.577 0.422821 28.55 0.380694 28.5108C0.338567 28.4716 0.307868 28.4217 0.291871 28.3664C-0.0347725 27.2524 -0.542236 24.7617 2.13507 22.6152Z"
        fill={`url(#${grad})`}
      />
      <path d="M35.3324 14.3786L40.4308 0.437716H43.4778L48.5563 14.3786H45.7084L41.9443 3.5047L38.1604 14.3786H35.3324ZM37.5828 11.212L38.2998 9.12087H45.3897L46.0868 11.212H37.5828Z" fill="currentColor" />
      <path d="M50.3882 14.3786V0.437716H55.0484C56.6682 0.437716 58.0025 0.72981 59.0514 1.314C60.1136 1.88491 60.8969 2.6948 61.4015 3.74369C61.9193 4.77929 62.1782 6.00077 62.1782 7.40814C62.1782 8.8155 61.9193 10.0436 61.4015 11.0925C60.8969 12.1281 60.1202 12.938 59.0713 13.5222C58.0225 14.0931 56.6815 14.3786 55.0484 14.3786H50.3882ZM53.0768 12.0684H54.909C56.0508 12.0684 56.947 11.8825 57.5976 11.5107C58.2614 11.139 58.7328 10.6079 59.0116 9.91749C59.2904 9.21381 59.4298 8.37736 59.4298 7.40814C59.4298 6.42564 59.2904 5.58919 59.0116 4.89879C58.7328 4.1951 58.2614 3.65739 57.5976 3.28563C56.947 2.91387 56.0508 2.728 54.909 2.728H53.0768V12.0684Z" fill="currentColor" />
      <path d="M70.9018 14.6175C69.5475 14.6175 68.3526 14.3122 67.317 13.7014C66.2814 13.0907 65.4715 12.2476 64.8873 11.1722C64.3031 10.0835 64.011 8.82877 64.011 7.40814C64.011 5.9875 64.3031 4.73946 64.8873 3.66402C65.4715 2.57531 66.2814 1.72558 67.317 1.11484C68.3526 0.504101 69.5475 0.19873 70.9018 0.19873C72.2693 0.19873 73.4709 0.504101 74.5065 1.11484C75.5421 1.72558 76.3453 2.57531 76.9162 3.66402C77.5004 4.73946 77.7925 5.9875 77.7925 7.40814C77.7925 8.82877 77.5004 10.0835 76.9162 11.1722C76.3453 12.2476 75.5421 13.0907 74.5065 13.7014C73.4709 14.3122 72.2693 14.6175 70.9018 14.6175ZM70.9018 12.2078C71.7515 12.2078 72.4817 12.0153 73.0925 11.6302C73.7165 11.2319 74.2011 10.6743 74.5463 9.95732C74.8915 9.24036 75.0641 8.39063 75.0641 7.40814C75.0641 6.41236 74.8915 5.56263 74.5463 4.85895C74.2011 4.142 73.7165 3.591 73.0925 3.20597C72.4817 2.82094 71.7515 2.62842 70.9018 2.62842C70.0653 2.62842 69.3351 2.82094 68.7111 3.20597C68.087 3.591 67.6024 4.142 67.2572 4.85895C66.912 5.56263 66.7394 6.41236 66.7394 7.40814C66.7394 8.39063 66.912 9.24036 67.2572 9.95732C67.6024 10.6743 68.087 11.2319 68.7111 11.6302C69.3351 12.0153 70.0653 12.2078 70.9018 12.2078Z" fill="currentColor" />
      <path d="M83.6226 14.3786L78.5442 0.437716H81.412L85.2756 11.6302L89.1591 0.437716H92.007L86.9286 14.3786H83.6226Z" fill="currentColor" />
      <path d="M93.681 14.3786V0.437716H96.3696V14.3786H93.681Z" fill="currentColor" />
      <path d="M98.1712 14.3786L103.27 0.437716H106.317L111.395 14.3786H108.547L104.783 3.5047L100.999 14.3786H98.1712ZM100.422 11.212L101.139 9.12087H108.229L108.926 11.212H100.422Z" fill="currentColor" />

      {/*
        ONE as live text rather than outlines, which is a real trade and worth
        naming. Outlines would render identically with no font loaded; live
        text depends on Space Grotesk arriving. The app already loads that face
        from Google Fonts for every heading on every screen, so if it fails,
        this sub-word is not the thing that broke — the whole interface is in a
        fallback, and the logo degrades with it rather than uniquely. What live
        text buys is that the product name stays text: it survives a font
        swap legibly, and the artwork is not something to re-cut when the
        product is renamed.

        The stack matters for that degraded case. Space Grotesk is a geometric
        sans, so the fallbacks are the closest geometric faces likely to be
        installed before giving up to the generic.
      */}
      <text
        x="35.8"
        y="28.4"
        fontFamily="'Space Grotesk', 'Futura', 'Century Gothic', sans-serif"
        fontWeight="500"
        fontSize="10.098"
        letterSpacing="2.02"
        fill="currentColor"
      >
        ONE
      </text>

      <defs>
        <linearGradient
          id={grad}
          x1="13.6662"
          y1="0"
          x2="13.6662"
          y2="28.596"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#E15D0A" />
          <stop offset="1" stopColor="#FF991B" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * The header signature: the lockup, and where in the product you are.
 *
 * Shared across the shell, the sign-in card and the not-set-up card, because
 * those three are the same statement of identity and had already settled into
 * three copies of the same markup.
 *
 * There is no "One" beside the logo any more. The lockup contains the product
 * name, so the old `Adovia <span>One</span>` next to it would have read
 * "Adovia One One".
 */
export function Brand({ ctx }: { ctx?: ReactNode }) {
  return (
    <div className="brand">
      <Logo />
      {/*
        Rendered only when there is something to say. The old markup emitted the
        separator unconditionally, so a client whose name had not arrived yet
        got a bare middot hanging off the wordmark.
      */}
      {ctx ? <span className="ctx">{ctx}</span> : null}
    </div>
  );
}
