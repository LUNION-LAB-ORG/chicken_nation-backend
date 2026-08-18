/**
 * Pastilles posées sur la vignette d'itinéraire.
 *
 * Google n'accepte, sur un marqueur standard, qu'une couleur et UNE lettre.
 * D'où le « R » et le « C » de la première version, que personne n'a à
 * déchiffrer sur une carte.
 *
 * Les glyphes viennent de FEATHER, la police d'icônes déjà utilisée par
 * l'application : `home` (U+F184) pour le restaurant, `map-pin` (U+F198) pour
 * le client. Ce sont donc, au pixel près, les mêmes icônes que les marqueurs
 * affichés dans l'écran de vérification. Redessinées à la main, elles auraient
 * dérivé au premier changement de charte.
 *
 * Embarquées en base64 plutôt que posées en fichier : le compilateur Nest ne
 * recopie pas les ressources sans configuration, et une image manquante en
 * production ferait basculer la vignette sur les marqueurs de secours sans
 * qu'on s'en aperçoive.
 *
 * 56 × 56 pixels : au-delà Google refuse, en dessous le glyphe devient illisible
 * une fois la carte réduite.
 */

const PIN_RESTAURANT_B64 = [
    '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',
    'Plgz8tiqGv6yu7wUqndbG6WCTCb7PUA5a/FPmktsxkVIX2SLlQTzEu87yFZJ3DWhanpNc4iddhngnNZavbN2/Y9/+9DPtk8cM6W/',
    'pWXBbnmmLkNnRcSk04lnezOZX2tjDLggcd4PMI3NSH/nwReGhvLSBnIZ9BGjSS74IaAsaK+3N/PazNNnPjRq4qnJOXNOad+jkL3X',
    'jowTEf3kCy98M5vLbQbtEUu55CU/R9cejWR7PxuQ2oR8z4+TvPReVM2RDme1tbbr9h/dfW3Mpf26+hHtN9544161DrW/3d2lS984',
    'Y1rz1Od8rQzaKNf+vsrcPR/X9XEYlA/bBmhYZ1V+nNTlv8KM/XNxNnDaeGbJH5b+3ZmzZz57/OSzvfVvP79x16mG/e8PllR1xoxT',
    'l7zz7rpvoo3GBqIbjpPUVY9gRk0K46P2hpgZ7MNbRnVWPWwkqb9/OAQXFJw2nlm7bsPNZ86e+fT4qX9Rvf7t/JY9VbOSQwhaKeWW',
    'LX/rmlOnTf4hzgraiGR79MCj36WwvAVVlQIvHsWzIWQK2gObRwa68SZ9kcSCO9C1oxy2AMbX61s3/vsJE8b9aNxJpzdktnd9sG3b',
    '25nBpPBKRJRSyi1dvuLbzVMm3+Z5xndgNZjC8ofJPvNvuJ1tYd3TxA7ttEWJHBfC3ah0PVVnXUPV7CuJEmcDsG5D600Tj5/w07FN',
    's0Z09HRv6W57p3NfqlkpRymBbHnsqfnz5p51e7yqanS0+6ukb4fOvfhT8ssfRnq2ghdH+YkoSS87BCTl2lOsn5QdBhILhSxSGEAl',
    'h+NP/TJVX/gWevix4px1WhtTCIKOZW+s+O6smdOfGts0a8TOro4Pez5c0/Fp4ColYUWQXHrFNVNvufm6H4yor5sbbeFYDcp1f6IL',
    'Kx6l8NaTuK3rkFxvKA3jo7QfpmvFZEEExCI2CB2Vs2GK13Ac/kl/hd88H10/Thw4HUmtp6/v5bv/+/7vf3fRtz4Y2zSrrhLJDfYw',
    'ngHqXln6+oLmU6ZeHYvFJpRtVwnOabt1rbIfvIZtW4ltfx/pbQ+ZRNHrag8VT6NSdeiGcZhjJuON/Rzm6CaJWAFFdSwUCh9t2PD+',
    'XSeeOPVXgNd44nR/8/YdW2hf01cJuEE4NsU999zjA9XNM85uWvPe+ptyudy6PY5CFo9Khkcp+7ud7djigm2tEmxvFbtzs7OZLrfn',
    'e+Ud5PP5tra2D++44KIrTwZGjRzX3DTyhOljYJo/FAd5K5ImNKSBuomTZzct+cPSr3d2dy8OCoWOwZ6GtUHQ09vbu2TlW+/+w5xz',
    'LpgMjCLWOLGxafbEmsYptYf9SLMC3li+3G/+wlfSdLf5QOKiK7496tIL5zcdP37sKdXDqk+IV8UaPWOOUEpVa6WMRGUi66TPOteV',
    'zee3ZDKZdRs3frjiiaeeWXXrzf/8EeBIN6bHjB3nsgOdHVtbV+0s37E93FUiUcALL77o/ePNd6Xe/F1Lomxb3D9i9JTUWWd+LtU0',
    'qakmnY77WmvJ9efcqtXrul55bXnflrWvZKLTiwaq40dOmGRqkrUD2a6tXZs3v9VTBmzQ9jYUulwaXCnF9df/JrZmze8Sa9ta4+9v',
    'aPMHOnZq6NzjoEyDqWoYphoaGkhV1wQqIBeYzkxrItHPSy8F++r7Mzl1vz+ge55/u+GGG8ySTZu8XH+/qkomJbFtm1RXVwctLS37',
    '40lD5iH/H1JcrdfECjwfAAAAAElFTkSuQmCC',
].join('');

const PIN_CLIENT_B64 = [
    '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',
    'naQBtiSuCq/Py8OPzaf860Pc/POrufqaKVRVVGJbFo6UrQVgR0psyyJQUcl1107l2qsmU/71IR5+bD5en7dNuaEwBNGIQ9/ePTAM',
    'QwNEItHy/ds31t90001HRTIl8ZsKhw5GmEab9FBrjcvl4vDhCn552yyUUjxb9BA/HjOKysoqbNs+qkpWWRXg3FEjeHLefUil+OVt',
    'szh8uKLN+i8QaCkpHDqoNVSrra3fDc3NCxbcpBMBfhq3GWcNLyAnx0/UaVv9RUpJVlYGK1a+w+133ovX6+G1Jc8xetRIqiqrsG0L',
    '27apqqxi5IhC/vbK86T7vMy4815WrHyHrKyMNpcwpJSkelIZdc5ZrVjKvvxqU6LhjAPcAuwHRNdTOqszCk6nqam5taaSfPVL4s/2',
    '8+RTL3DXPY/gz8rkzb+9wEXjx1BVUUVVRRUXjR/Dyjf+QofcbO665xGefPoF/Nn+pJPdxOCiORSiX99enD5wgAYMKWXT4uUrSgAR',
    'o6wwYtlvBHgnJmZ1+f9cgmyjHibuqj/Hz0MPP8WMmfeRnu7jzeUv8YubruXmX1zLW8tfIjMjnRkz7+Ohh5/Cn+1vV/HJMAzCTSEm',
    'XToOl8tWgG5sbN780lPz9g0dM0XFqS6OKdN/DKj6+gaj4KyxHK6oxGXbbW6mxFOZQFWAa66ZwsL5j+J2t3Sww+EIN/7qTha/vIzs',
    'nGwcKdvbjMU0TTavW0VeXlcJmOuKS+4cObxgcVFRUc20adPCrYXeWCf1E2ADINLTvfLGG66kqb5tBaGj6Col2bk5LH55OT8aexmb',
    'Nm9l0+at/GjsVBYvWU52bk67wVmWRX1dPZdPuYS8vK4KMKJR5/DsOQ+8m+rvak6fPj18rKOPd5KuAl4GZDDYaBaePZ4D5QdJaUPh',
    '6Xi1mrq6IB5PGi0BfRMZGb4261yi75NS4na72LRuFd26dpGAWfbVvqK+PXs8euGU/w2tWfZCdQxbSw88Bs4AXo25DMPn88hHHphF',
    'c3OotTvbvrK7JD3d23qenu5tN7jWsmRtHXNmTadb1y5KKWVEo07FnXc/tCijY3d3Bj+pSyyFGkdvjnAaG0O/BYSUkomX/IQbb7iS',
    'QEXgKF/WdsOjYuX779dus22LQKCGcRddwC03X49SShmGIbbuKH3yjSXPVwzoMbhp2bKpMjH6NhLQSa216fWm/jPY2LjUNE1TKeX8',
    '8dF7GDa8gJqaWmzL+h4TGv9JFdtzmKZJsKGRvO5d+dMzjyKEkIZhWMFg4/qRo0Yu6TJgWNrYsWdUHlPI/kZHRmmtjbf+9a9bQ+Hw',
    'PsMwLI8nTb368rN069qF+mBDa1/hhzxM0yQUCpOWksJrS56lS+eOSkppSClrHy967g6X8trZOR0q7733XnVsS1CcqLu7bl3xeYWF',
    'Q9YIIUzTNMWu3V+KsRdfzYHyg2RlZf5wDVDLItjQSFpaCm8t/zNnjyjU0aijbNsyP/ho3Y3njx75z36DLrBKt7yzN25Yvq0/2ErV',
    'ESOGfbBl265bTdM0oo6j+/ftpdes/CuD8k+lqqIKy7KSzvzbay1t2yJQXUOXzh1Y/ebLnD2iUEeiUWXblrlj1+4Hzx89cmWfIT/y',
    'lW6JHDiWmicEmADSGFqQv6B445bbbcsypJT07d1Dvb/mNa6+ajKBqgCRaBTLstoV8Xxbbm5ZFlJKqiqqGHvBeXz07nKGFw5R0aij',
    'XbZtlpbtffi0Af2e7nX6qJzgoap98OEJe/TGt+yg1lobwwsHP7F+4+bpWrdMMmWk++TiF4v4ywtFZGf7CVQGkFK2SNQw+D5DB5Zl',
    'obQmUFVNSoqbeY/N5e1/LKLrKZ2l1hi2bRm7dpc90L9vr6Ke+ed0CNTVlB85sqXx26ZFvmvrhdZaCCHUstdXTJkwfszjKW53t1j3',
    'V1RUBozHn1jAor8u5/ChI7jcbtLSUjFN4xtDQK2xYUzaiR1fKRWhUIhQc4gsfxZTJ09g5q9/Rc8e3XRsdsR0HKf60+JNM88ZeeaK',
    'nvnndAjUVpfXl2+vPp7etZk1sSDAuP6m6WccqaxamTA052itZfnXh/Sj857Vw8+9WHtz+mvcp2hSumlXei+d5u+nfbkDdEbH03RG',
    'x9N0eodTtSe7n3Zl9NIitZvGdYpOzeqjBw27UM+57zG9u2yvjg3nOfGX1AWDHz8y78lzgVN65p8zKKP76VnJTmq1dRjPBLI/Wffp',
    '1MIzhtzicrn6JrSrtFLK2Lptp/j32mKKN5awa/deKiqqCDY0EIlEW+NIn89Dbrafvn16csaQ0znn7GEMGTRQu92ueBRgtvTlo1/v',
    '3r3nmYEDh/wVsPIGnmnvq6g6QOX2hpMhueNatgULFtiAr3DEBfnbd5Y+EA6Hdx0zChkflXS01rK2tk7t21+udpXu0btK9+i9X+1X',
    '1TW16tjrEh8QiUT2799fPu/ya24uALp07FWY37H/mT1gqH0yBnmTkibkeoHsAYNG53/w0bpf1dTVrY5Go9XtnYZ1HKe+Lhj8YPPn',
    '224fe/Hlg4AuuPIG5OWPHpCRNzjzBx9pFkDxhg124Y8neanbbwOp19w0rcv1V0zJ79en5xm+dF//FLcrzzTNLCGEL0ZvoTVSa9Ug',
    'laoNRyIHGhsbd+3dW77pHytWlTz64OyvAYU3z9ujZy8Vaq6pPlxWEkjs2P6QM9sC0AL41/vvW7958BnPxneXpSa0xe2sboM9Y84/',
    'y5N/Wn6G15tiG4ahw01hVfLFrtpP1m9oOLDjk8bY6IcJvpROfU8zM9Iym0O1h2v37fu8PgFYu/VNnCTfrOM6OmfOq67t299N3bG/',
    'LGXP7v12c3XAgJr4dbH35Zru3HSRm5uLx5fhCIewY9Y0lqWmNvHhUU77+7uAk2mDjrcYrbWYO3eu+cFXX1nhpibhTkvTqUeOaJ/P',
    '5yxbtkydAMBJs5D/B8IOPhCrjmnRAAAAAElFTkSuQmCC',
].join('');

/**
 * Une `Map` et non un objet : la clé vient de l'URL, et un objet littéral
 * répond aussi pour `toString`, `constructor` ou `__proto__`, hérités de son
 * prototype. Le garde-fou « inconnu » les laissait passer, et le serveur
 * renvoyait alors une erreur 500 au lieu d'un 404.
 */
export const PINS_VIGNETTE = new Map<string, Buffer>([
  ['restaurant', Buffer.from(PIN_RESTAURANT_B64, 'base64')],
  ['client', Buffer.from(PIN_CLIENT_B64, 'base64')],
]);
