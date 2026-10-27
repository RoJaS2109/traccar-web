import { useTheme, useMediaQuery } from '@mui/material';
import { useSelector } from 'react-redux';
import { makeStyles } from 'tss-react/mui';
import logoLightBackground from '../resources/images/logo-fondo-claro.png';
import logoDarkBackground from '../resources/images/logo-fondo-oscuro.png';

const useStyles = makeStyles()((theme) => ({
  image: {
    alignSelf: 'center',
    maxWidth: 'min(420px, 80%)',
    maxHeight: '210px',
    width: 'auto',
    height: 'auto',
    margin: theme.spacing(2),
  },
}));

const LogoImage = () => {
  const theme = useTheme();
  const { classes } = useStyles();

  const expanded = !useMediaQuery(theme.breakpoints.down('lg'));

  const logo = useSelector((state) => state.session.server.attributes?.logo);
  const logoInverted = useSelector((state) => state.session.server.attributes?.logoInverted);

  if (logo) {
    if (expanded && logoInverted) {
      return <img className={classes.image} src={logoInverted} alt="" />;
    }
    return <img className={classes.image} src={logo} alt="" />;
  }
  // Expandido, el logo va sobre la barra lateral de asfalto.
  const darkBackground = expanded || theme.palette.mode === 'dark';
  return (
    <img
      className={classes.image}
      src={darkBackground ? logoDarkBackground : logoLightBackground}
      alt=""
    />
  );
};

export default LogoImage;
